/// <reference lib="webworker" />

import { blendFacialFeatures } from "./FacialFeatures";
import { alignFace } from "./FaceAlignment";
import { assessFaceQuality } from "./FaceQuality";
import { EmotionClassifier } from "./EmotionClassifier";
import { EmotionSmoother } from "./EmotionSmoother";
import { FaceLandmarkerRuntime } from "./FaceLandmarkerRuntime";
import type {
  FacialFeatures,
  QualityIssue,
  VisionAssetUrls,
  VisionResult,
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
    highConfidenceSwitch: options.highConfidenceSwitch,
  });
  smoothedFeatures = null;
}

async function closeRuntimes(): Promise<void> {
  const activeClassifier = classifier;
  const activeLandmarker = landmarker;
  classifier = null;
  landmarker = null;
  smoother.reset();
  smoothedFeatures = null;
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

  const nextClassifier = await EmotionClassifier.create({
    modelUrl: assets.emotionModelUrl,
    ortWasmRoot: assets.ortWasmRoot,
  });
  try {
    post({
      type: "INITIALIZING",
      stage: "models",
      message: "顔ランドマークモデルを読み込んでいます…",
    });
    const nextLandmarker = await FaceLandmarkerRuntime.create({
      modelUrl: assets.faceLandmarkerModelUrl,
      wasmRoot: assets.mediaPipeWasmRoot,
    });
    classifier = nextClassifier;
    landmarker = nextLandmarker;
    if (nextClassifier.fallbackReason !== null) {
      post({
        type: "WARNING",
        code: "webgpu-fallback",
        message: `WebGPUを使用できないためWASMに切り替えました: ${nextClassifier.fallbackReason}`,
      });
    }
    post({ type: "READY", provider: nextClassifier.provider });
  } catch (error) {
    await nextClassifier.close();
    throw error;
  }
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
  try {
    const detection = activeLandmarker.detect(frame, timestampMs);
    const face = detection.primaryFace;
    if (face === null) {
      smoother.reset();
      smoothedFeatures = null;
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
        ),
      );
      return;
    }

    const aligned = alignFace(frame, face.fivePoints);
    if (aligned === null) {
      smoother.reset();
      smoothedFeatures = null;
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
        ),
      );
      return;
    }

    const quality = assessFaceQuality(aligned.imageData, face.pixelBox);
    if (quality.issue !== null) {
      smoother.reset();
      smoothedFeatures = null;
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
        ),
      );
      return;
    }

    smoothedFeatures =
      smoothedFeatures === null
        ? face.features
        : blendFacialFeatures(smoothedFeatures, face.features);
    const providerBeforeInference = activeClassifier.provider;
    const probabilities = await activeClassifier.classify(aligned.imageData);
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
    const decision = smoother.update(probabilities);
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
    });
  } catch (error) {
    smoother.reset();
    smoothedFeatures = null;
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
