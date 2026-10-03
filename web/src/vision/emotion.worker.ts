/// <reference lib="webworker" />

import { blendFacialFeatures } from "./FacialFeatures";
import { FaceAligner } from "./FaceAlignment";
import { assessFaceQuality, DEFAULT_FACE_QUALITY_THRESHOLDS, FaceQualityWorkspace, minimumFaceSizeForFrame } from "./FaceQuality";
import { EmotionClassifier } from "./EmotionClassifier";
import { EmotionSmoother, timeAdjustedAlpha } from "./EmotionSmoother";
import { VISION_STABILITY } from "../RuntimeSettings";
import { FaceLandmarkerRuntime } from "./FaceLandmarkerRuntime";
import type {
  FacialFeatures,
  QualityIssue,
  VisionAssetUrls,
  VisionResult,
  VisionStageTimings,
} from "./types";
import {
  closeFrameFromUnknownMessage,
  parseWorkerRequest,
  type WorkerInferenceOptions,
  type VisionWorkerResponse,
} from "./workerProtocol";

interface WorkerEndpoint {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: VisionWorkerResponse): void;
}

const endpoint = globalThis as unknown as WorkerEndpoint;
let smoother = new EmotionSmoother();
let classifier: EmotionClassifier | null = null;
let landmarker: FaceLandmarkerRuntime | null = null;
let smoothedFeatures: FacialFeatures | null = null;
let lastFeatureTimestampMs: number | null = null;
let stateEpoch = 0;
const aligner = new FaceAligner();
const qualityWorkspace = new FaceQualityWorkspace();
let busy = false;
let stopping = false;

type WorkerFrame = ImageBitmap | ImageData;

function closeFrame(frame: WorkerFrame): void {
  if ("close" in frame && typeof frame.close === "function") {
    frame.close();
  }
}

function post(message: VisionWorkerResponse): void {
  endpoint.postMessage(message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(
  frameId: number,
  timestampMs: number,
  startedAt: number,
  faceCount: number,
  qualityIssue: QualityIssue,
  cameraWidth: number,
  cameraHeight: number,
  faceBox: VisionResult["faceBox"] = null,
  stageTimings?: VisionStageTimings,
): VisionResult {
  const inferenceMs = Math.max(0, performance.now() - startedAt);
  return {
    frameId,
    timestampMs,
    inferenceMs,
    aiFps: inferenceMs > 0 ? 1000 / inferenceMs : 0,
    faceCount,
    cameraWidth,
    cameraHeight,
    faceBox,
    emotion: null,
    candidate: null,
    confidence: 0,
    margin: 0,
    uncertain: true,
    uncertaintyReason: qualityIssue,
    probabilities: new Array<number>(8).fill(0),
    qualityIssue,
    features: null,
    stageTimings,
  };
}

function publishResult(
  provider: "webgpu" | "wasm",
  result: VisionResult,
): void {
  post({ type: "RESULT", provider, result });
  post({
    type: "METRICS",
    frameId: result.frameId,
    inferenceMs: result.inferenceMs,
    aiFps: result.aiFps,
  });
}

function replaceSmoother(options: WorkerInferenceOptions): void {
  smoother = new EmotionSmoother({
    alpha: options.smoothingAlpha,
    confidenceThreshold: options.confidenceThreshold,
    marginThreshold: options.marginThreshold,
    switchConfirmations: options.switchConfirmations,
    switchConfirmationMs: options.switchConfirmationMs,
    highConfidenceSwitch: options.highConfidenceSwitch,
    emotionThresholds: options.emotionThresholds,
  });
  smoothedFeatures = null;
  lastFeatureTimestampMs = null;
  stateEpoch += 1;
}

async function closeRuntimes(): Promise<void> {
  const activeClassifier = classifier;
  const activeLandmarker = landmarker;
  classifier = null;
  landmarker = null;
  smoother.reset();
  smoothedFeatures = null;
  lastFeatureTimestampMs = null;
  stateEpoch += 1;
  aligner.dispose();
  qualityWorkspace.dispose();
  activeLandmarker?.close();
  await activeClassifier?.close();
}

async function initialize(assets: VisionAssetUrls): Promise<void> {
  await closeRuntimes();
  stopping = false;
  post({
    type: "INITIALIZING",
    stage: "runtime",
    message: "AIモデルを読み込んでいます…",
  });

  const startedAt = performance.now();
  const timed = async <T>(label: string, task: Promise<T>): Promise<T> => {
    const value = await task;
    post({ type: "INITIALIZING", stage: "models", message: `${label} 準備完了 (${((performance.now() - startedAt) / 1000).toFixed(1)}秒)・残りを準備中…` });
    return value;
  };
  // 独立したモデルを並列準備、片方失敗時も解放 / 并行初始化独立模型，失败时释放已成功的另一项。
  const [classification, detection] = await Promise.allSettled([
    timed("表情モデル", EmotionClassifier.create({ modelUrl: assets.emotionModelUrl, ortWasmRoot: assets.ortWasmRoot })),
    timed("顔モデル", FaceLandmarkerRuntime.create({
      modelUrl: assets.faceLandmarkerModelUrl,
      wasmRoot: assets.mediaPipeWasmRoot,
    })),
  ]);
  if (stopping || classification.status === "rejected" || detection.status === "rejected") {
    if (classification.status === "fulfilled") await classification.value.close();
    if (detection.status === "fulfilled") detection.value.close();
    if (stopping) return;
    throw classification.status === "rejected" ? classification.reason : detection.status === "rejected" ? detection.reason : new Error("AI初期化失敗");
  }
  classifier = classification.value;
  landmarker = detection.value;
  if (classifier.fallbackReason !== null) {
    post({
      type: "WARNING",
      code: "webgpu-fallback",
      message: `WebGPUを使用できないためWASMに切り替えました: ${classifier.fallbackReason}`,
    });
  }
  post({ type: "READY", provider: classifier.provider });
}

async function processFrame(
  frameId: number,
  timestampMs: number,
  frame: WorkerFrame,
): Promise<void> {
  const activeClassifier = classifier;
  const activeLandmarker = landmarker;
  if (stopping || activeClassifier === null || activeLandmarker === null) {
    closeFrame(frame);
    post({
      type: "ERROR",
      message: "Vision worker is not ready",
      recoverable: true,
      frameId,
    });
    return;
  }
  if (busy) {
    closeFrame(frame);
    post({
      type: "WARNING",
      code: "frame-dropped",
      message: "A vision frame is already in flight",
      frameId,
    });
    return;
  }

  busy = true;
  const startedAt = performance.now();
  const epoch = stateEpoch;
  const stageTimings = { landmarksMs: 0, alignmentQualityMs: 0, classificationMs: 0, smoothingMs: 0 };
  try {
    const detection = activeLandmarker.detect(frame, timestampMs);
    stageTimings.landmarksMs = Math.max(0, performance.now() - startedAt);
    const face = detection.primaryFace;
    if (face === null) {
      smoother.reset();
      smoothedFeatures = null;
      lastFeatureTimestampMs = null;
      publishResult(
        activeClassifier.provider,
        emptyResult(
          frameId,
          timestampMs,
          startedAt,
          detection.faceCount,
          "no-face",
          frame.width,
          frame.height,
          null,
          stageTimings,
        ),
      );
      return;
    }

    // 小さい顔は整列前に除外 / 过小人脸先退出，不做画布对齐及像素分析。
    if (Math.min(face.pixelBox.width, face.pixelBox.height) < minimumFaceSizeForFrame(frame.width)) {
      smoother.reset();
      smoothedFeatures = null;
      lastFeatureTimestampMs = null;
      publishResult(activeClassifier.provider, emptyResult(frameId, timestampMs, startedAt,
        detection.faceCount, "small", frame.width, frame.height, face.normalizedBox, stageTimings));
      return;
    }
    const alignmentStartedAt = performance.now();
    const aligned = aligner.align(frame, face.fivePoints);
    if (aligned === null) {
      smoother.reset();
      smoothedFeatures = null;
      lastFeatureTimestampMs = null;
      stageTimings.alignmentQualityMs = Math.max(0, performance.now() - alignmentStartedAt);
      publishResult(
        activeClassifier.provider,
        emptyResult(
          frameId,
          timestampMs,
          startedAt,
          detection.faceCount,
          "alignment",
          frame.width,
          frame.height,
          face.normalizedBox,
          stageTimings,
        ),
      );
      return;
    }

    const quality = assessFaceQuality(aligned.imageData, face.pixelBox, DEFAULT_FACE_QUALITY_THRESHOLDS,
      { frameWidth: frame.width, workspace: qualityWorkspace });
    stageTimings.alignmentQualityMs = Math.max(0, performance.now() - alignmentStartedAt);
    if (quality.issue !== null) {
      smoother.reset();
      smoothedFeatures = null;
      lastFeatureTimestampMs = null;
      publishResult(
        activeClassifier.provider,
        emptyResult(
          frameId,
          timestampMs,
          startedAt,
          detection.faceCount,
          quality.issue,
          frame.width,
          frame.height,
          face.normalizedBox,
          stageTimings,
        ),
      );
      return;
    }

    const providerBeforeInference = activeClassifier.provider;
    const classificationStartedAt = performance.now();
    const probabilities = await activeClassifier.classify(aligned.imageData);
    stageTimings.classificationMs = Math.max(0, performance.now() - classificationStartedAt);
    if (stopping || epoch !== stateEpoch) {
      // RESET前に開始した結果を捨て、背圧だけ解除 / 丢弃复位前开始的结果，同时通知主线程释放背压。
      post({ type: "WARNING", code: "frame-dropped", message: "Inference history was reset", frameId });
      return;
    }
    if (
      providerBeforeInference === "webgpu" &&
      activeClassifier.provider === "wasm"
    ) {
      post({
        type: "WARNING",
        code: "webgpu-fallback",
        message:
          activeClassifier.fallbackReason ??
          "WebGPUが停止したためWASMに切り替えました。",
      });
    }
    const smoothingStartedAt = performance.now();
    const featureDelta = lastFeatureTimestampMs === null ? VISION_STABILITY.referenceIntervalMs : timestampMs - lastFeatureTimestampMs;
    smoothedFeatures = smoothedFeatures === null || featureDelta > VISION_STABILITY.sampleGapResetMs
      ? face.features
      : blendFacialFeatures(smoothedFeatures, face.features, timeAdjustedAlpha(0.45, featureDelta));
    lastFeatureTimestampMs = timestampMs;
    const decision = smoother.update(probabilities, timestampMs);
    stageTimings.smoothingMs = Math.max(0, performance.now() - smoothingStartedAt);
    const inferenceMs = Math.max(0, performance.now() - startedAt);
    publishResult(activeClassifier.provider, {
        ...decision,
        frameId,
        timestampMs,
        inferenceMs,
        aiFps: inferenceMs > 0 ? 1000 / inferenceMs : 0,
        faceCount: detection.faceCount,
        cameraWidth: frame.width,
        cameraHeight: frame.height,
        faceBox: face.normalizedBox,
        qualityIssue: null,
        features: smoothedFeatures,
        stageTimings,
    });
  } catch (error) {
    if (stopping || epoch !== stateEpoch) {
      post({ type: "WARNING", code: "frame-dropped", message: "Inference history was reset", frameId });
      return;
    }
    smoother.reset();
    smoothedFeatures = null;
    lastFeatureTimestampMs = null;
    post({
      type: "ERROR",
      message: describeError(error),
      recoverable: true,
      frameId,
    });
  } finally {
    closeFrame(frame);
    busy = false;
  }
}

async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  post({ type: "STATUS", status: "stopping", message: "停止しています…" });
  await closeRuntimes();
  post({ type: "STOPPED" });
}

async function handleMessage(value: unknown): Promise<void> {
  try {
    const request = parseWorkerRequest(value);
    switch (request.type) {
      case "INIT":
        await initialize(request.assets);
        break;
      case "FRAME":
        await processFrame(
          request.frameId,
          request.timestampMs,
          "bitmap" in request && request.bitmap !== undefined
            ? request.bitmap
            : request.imageData,
        );
        break;
      case "RESET":
        smoother.reset();
        smoothedFeatures = null;
        lastFeatureTimestampMs = null;
        stateEpoch += 1;
        break;
      case "UPDATE_OPTIONS":
        replaceSmoother(request.options);
        break;
      case "STOP":
        await stop();
        break;
    }
  } catch (error) {
    closeFrameFromUnknownMessage(value);
    post({
      type: "ERROR",
      message: describeError(error),
      recoverable: false,
    });
  }
}

if (typeof document === "undefined" && typeof endpoint.postMessage === "function") {
  endpoint.addEventListener("message", (event) => {
    void handleMessage(event.data);
  });
}
