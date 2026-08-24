import {
  type FacialFeatures,
  type FaceBox,
  type QualityIssue,
  type UncertaintyReason,
  type VisionAssetUrls,
  type VisionExecutionProvider,
  type VisionResult,
  isEmotionLabel,
} from "./types";

export interface WorkerInitRequest {
  readonly type: "INIT";
  readonly assets: VisionAssetUrls;
}

interface WorkerFrameRequestBase {
  readonly type: "FRAME";
  readonly frameId: number;
  readonly timestampMs: number;
}

export type WorkerFrameRequest =
  | (WorkerFrameRequestBase & {
      readonly bitmap: ImageBitmap;
      readonly imageData?: never;
    })
  | (WorkerFrameRequestBase & {
      readonly bitmap?: never;
      readonly imageData: ImageData;
    });

export interface WorkerStopRequest {
  readonly type: "STOP";
}

export interface WorkerResetRequest {
  readonly type: "RESET";
}

export interface WorkerInferenceOptions {
  readonly smoothingAlpha?: number;
  readonly confidenceThreshold?: number;
  readonly marginThreshold?: number;
  readonly switchConfirmations?: number;
  readonly highConfidenceSwitch?: number;
}

export interface WorkerUpdateOptionsRequest {
  readonly type: "UPDATE_OPTIONS";
  readonly options: WorkerInferenceOptions;
}

export type VisionWorkerRequest =
  | WorkerInitRequest
  | WorkerFrameRequest
  | WorkerResetRequest
  | WorkerUpdateOptionsRequest
  | WorkerStopRequest;

export type VisionWorkerResponse =
  | {
      readonly type: "INITIALIZING";
      readonly stage: "runtime" | "models";
      readonly message: string;
    }
  | {
      readonly type: "STATUS";
      readonly status: "loading-models" | "stopping";
      readonly message: string;
    }
  | {
      readonly type: "READY";
      readonly provider: VisionExecutionProvider;
    }
  | {
      readonly type: "RESULT";
      readonly provider: VisionExecutionProvider;
      readonly result: VisionResult;
    }
  | {
      readonly type: "WARNING";
      readonly code: "frame-dropped" | "webgpu-fallback" | "runtime";
      readonly message: string;
      readonly frameId?: number;
    }
  | {
      readonly type: "ERROR";
      readonly message: string;
      readonly recoverable: boolean;
      readonly frameId?: number;
    }
  | {
      readonly type: "STOPPED";
    }
  | {
      readonly type: "METRICS";
      readonly frameId: number;
      readonly inferenceMs: number;
      readonly aiFps: number;
    };

export class VisionProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VisionProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isImageBitmap(value: unknown): value is ImageBitmap {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    isFiniteNumber(value.height) &&
    value.height > 0 &&
    typeof value.close === "function"
  );
}

function isImageData(value: unknown): value is ImageData {
  if (!isRecord(value)) {
    return false;
  }
  const { data, width, height } = value;
  return (
    isNonNegativeInteger(width) &&
    width > 0 &&
    isNonNegativeInteger(height) &&
    height > 0 &&
    data instanceof Uint8ClampedArray &&
    data.length === width * height * 4
  );
}

function isAssetUrls(value: unknown): value is VisionAssetUrls {
  if (!isRecord(value)) {
    return false;
  }
  return [
    value.emotionModelUrl,
    value.faceLandmarkerModelUrl,
    value.mediaPipeWasmRoot,
    value.ortWasmRoot,
  ].every((entry) => typeof entry === "string" && entry.length > 0);
}

function isFaceBox(value: unknown): value is FaceBox {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    value.width >= 0 &&
    isFiniteNumber(value.height) &&
    value.height >= 0
  );
}

function isFacialFeatures(value: unknown): value is FacialFeatures {
  if (!isRecord(value)) {
    return false;
  }
  return [
    value.mouthOpenRatio,
    value.jawOpen,
    value.browRaise,
    value.browFurrow,
    value.smile,
    value.eyeWide,
  ].every(isFiniteNumber);
}

const QUALITY_ISSUES = new Set<QualityIssue>([
  "no-face",
  "small",
  "blur",
  "lighting",
  "alignment",
]);

const UNCERTAINTY_REASONS = new Set<UncertaintyReason>([
  ...QUALITY_ISSUES,
  "low-confidence",
  "low-margin",
  "switch-pending",
]);

function isQualityIssue(value: unknown): value is QualityIssue {
  return typeof value === "string" && QUALITY_ISSUES.has(value as QualityIssue);
}

function isUncertaintyReason(value: unknown): value is UncertaintyReason {
  return (
    typeof value === "string" &&
    UNCERTAINTY_REASONS.has(value as UncertaintyReason)
  );
}

function isWarningCode(
  value: unknown,
): value is "frame-dropped" | "webgpu-fallback" | "runtime" {
  return (
    value === "frame-dropped" ||
    value === "webgpu-fallback" ||
    value === "runtime"
  );
}

function isWorkerInferenceOptions(value: unknown): value is WorkerInferenceOptions {
  if (!isRecord(value)) {
    return false;
  }
  const probabilityKeys = [
    "smoothingAlpha",
    "confidenceThreshold",
    "marginThreshold",
    "highConfidenceSwitch",
  ] as const;
  for (const key of probabilityKeys) {
    const entry = value[key];
    if (
      entry !== undefined &&
      (!isFiniteNumber(entry) || entry < 0 || entry > 1)
    ) {
      return false;
    }
  }
  const confirmations = value.switchConfirmations;
  return (
    confirmations === undefined ||
    (isNonNegativeInteger(confirmations) && confirmations >= 1)
  );
}

function isVisionResult(value: unknown): value is VisionResult {
  if (!isRecord(value)) {
    return false;
  }
  const emotionIsValid = value.emotion === null || isEmotionLabel(value.emotion);
  const candidateIsValid =
    value.candidate === null || isEmotionLabel(value.candidate);
  const probabilitiesAreValid =
    Array.isArray(value.probabilities) &&
    value.probabilities.length === 8 &&
    value.probabilities.every(isFiniteNumber);
  const qualityIsValid =
    value.qualityIssue === null || isQualityIssue(value.qualityIssue);
  const featuresAreValid =
    value.features === null || isFacialFeatures(value.features);
  const boxIsValid = value.faceBox === null || isFaceBox(value.faceBox);
  const reasonIsValid =
    value.uncertaintyReason === null ||
    isUncertaintyReason(value.uncertaintyReason);

  return (
    isNonNegativeInteger(value.frameId) &&
    isFiniteNumber(value.timestampMs) &&
    value.timestampMs >= 0 &&
    isFiniteNumber(value.inferenceMs) &&
    value.inferenceMs >= 0 &&
    isFiniteNumber(value.aiFps) &&
    value.aiFps >= 0 &&
    isNonNegativeInteger(value.faceCount) &&
    isNonNegativeInteger(value.cameraWidth) &&
    value.cameraWidth > 0 &&
    isNonNegativeInteger(value.cameraHeight) &&
    value.cameraHeight > 0 &&
    emotionIsValid &&
    candidateIsValid &&
    isFiniteNumber(value.confidence) &&
    isFiniteNumber(value.margin) &&
    typeof value.uncertain === "boolean" &&
    reasonIsValid &&
    probabilitiesAreValid &&
    qualityIsValid &&
    featuresAreValid &&
    boxIsValid
  );
}

export function parseWorkerRequest(value: unknown): VisionWorkerRequest {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new VisionProtocolError("Worker request must be an object with a type");
  }

  switch (value.type) {
    case "INIT":
      if (!isAssetUrls(value.assets)) {
        throw new VisionProtocolError("INIT request has invalid asset URLs");
      }
      return { type: "INIT", assets: value.assets };
    case "FRAME": {
      const bitmapIsValid = isImageBitmap(value.bitmap);
      const imageDataIsValid = isImageData(value.imageData);
      if (
        !isNonNegativeInteger(value.frameId) ||
        !isFiniteNumber(value.timestampMs) ||
        value.timestampMs < 0 ||
        bitmapIsValid === imageDataIsValid
      ) {
        throw new VisionProtocolError("FRAME request is invalid");
      }
      if (isImageBitmap(value.bitmap)) {
        return {
          type: "FRAME",
          frameId: value.frameId,
          timestampMs: value.timestampMs,
          bitmap: value.bitmap,
        };
      }
      if (!isImageData(value.imageData)) {
        throw new VisionProtocolError("FRAME request has no valid payload");
      }
      return {
        type: "FRAME",
        frameId: value.frameId,
        timestampMs: value.timestampMs,
        imageData: value.imageData,
      };
    }
    case "RESET":
      return { type: "RESET" };
    case "UPDATE_OPTIONS":
      if (!isWorkerInferenceOptions(value.options)) {
        throw new VisionProtocolError("UPDATE_OPTIONS request is invalid");
      }
      return { type: "UPDATE_OPTIONS", options: value.options };
    case "STOP":
      return { type: "STOP" };
    default:
      throw new VisionProtocolError(`Unknown worker request: ${value.type}`);
  }
}

export function parseWorkerResponse(value: unknown): VisionWorkerResponse {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new VisionProtocolError("Worker response must be an object with a type");
  }

  switch (value.type) {
    case "INITIALIZING":
      if (
        (value.stage !== "runtime" && value.stage !== "models") ||
        typeof value.message !== "string"
      ) {
        throw new VisionProtocolError("INITIALIZING response is invalid");
      }
      return {
        type: "INITIALIZING",
        stage: value.stage,
        message: value.message,
      };
    case "STATUS":
      if (
        (value.status !== "loading-models" && value.status !== "stopping") ||
        typeof value.message !== "string"
      ) {
        throw new VisionProtocolError("STATUS response is invalid");
      }
      return { type: "STATUS", status: value.status, message: value.message };
    case "READY":
      if (value.provider !== "webgpu" && value.provider !== "wasm") {
        throw new VisionProtocolError("READY response has an invalid provider");
      }
      return { type: "READY", provider: value.provider };
    case "RESULT":
      if (
        (value.provider !== "webgpu" && value.provider !== "wasm") ||
        !isVisionResult(value.result)
      ) {
        throw new VisionProtocolError("RESULT response is invalid");
      }
      return { type: "RESULT", provider: value.provider, result: value.result };
    case "WARNING": {
      if (!isWarningCode(value.code) || typeof value.message !== "string") {
        throw new VisionProtocolError("WARNING response is invalid");
      }
      const warning = {
        type: "WARNING" as const,
        code: value.code,
        message: value.message,
      };
      if (value.frameId === undefined) {
        return warning;
      }
      if (!isNonNegativeInteger(value.frameId)) {
        throw new VisionProtocolError("WARNING response frameId is invalid");
      }
      return { ...warning, frameId: value.frameId };
    }
    case "ERROR": {
      if (
        typeof value.message !== "string" ||
        typeof value.recoverable !== "boolean"
      ) {
        throw new VisionProtocolError("ERROR response is invalid");
      }
      const base = {
        type: "ERROR" as const,
        message: value.message,
        recoverable: value.recoverable,
      };
      if (value.frameId === undefined) {
        return base;
      }
      if (!isNonNegativeInteger(value.frameId)) {
        throw new VisionProtocolError("ERROR response frameId is invalid");
      }
      return { ...base, frameId: value.frameId };
    }
    case "STOPPED":
      return { type: "STOPPED" };
    case "METRICS":
      if (
        !isNonNegativeInteger(value.frameId) ||
        !isFiniteNumber(value.inferenceMs) ||
        value.inferenceMs < 0 ||
        !isFiniteNumber(value.aiFps) ||
        value.aiFps < 0
      ) {
        throw new VisionProtocolError("METRICS response is invalid");
      }
      return {
        type: "METRICS",
        frameId: value.frameId,
        inferenceMs: value.inferenceMs,
        aiFps: value.aiFps,
      };
    default:
      throw new VisionProtocolError(`Unknown worker response: ${value.type}`);
  }
}

/** Allows exactly one transferred frame to be owned by the worker at a time. */
export class SingleFrameBackpressure {
  private activeFrameId: number | null = null;

  public get inFlight(): boolean {
    return this.activeFrameId !== null;
  }

  public get frameId(): number | null {
    return this.activeFrameId;
  }

  public acquire(frameId: number): boolean {
    if (!isNonNegativeInteger(frameId) || this.activeFrameId !== null) {
      return false;
    }
    this.activeFrameId = frameId;
    return true;
  }

  public complete(frameId: number): boolean {
    if (this.activeFrameId !== frameId) {
      return false;
    }
    this.activeFrameId = null;
    return true;
  }

  public reset(): void {
    this.activeFrameId = null;
  }
}

export function closeFrameFromUnknownMessage(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const bitmap = value.bitmap;
  if (isImageBitmap(bitmap)) {
    bitmap.close();
  }
}
