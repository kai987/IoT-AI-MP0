export const EMOTION_LABELS = [
  "anger",
  "contempt",
  "disgust",
  "fear",
  "happiness",
  "neutral",
  "sadness",
  "surprise",
] as const;

export type EmotionLabel = (typeof EMOTION_LABELS)[number];

export type QualityIssue =
  | "no-face"
  | "small"
  | "blur"
  | "lighting"
  | "alignment";

export type UncertaintyReason =
  | QualityIssue
  | "low-confidence"
  | "low-margin"
  | "switch-pending";

export type VisionExecutionProvider = "webgpu" | "wasm";

export type VisionStatus =
  | "idle"
  | "requesting-camera"
  | "loading-models"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

export interface NormalizedPoint3D extends Point2D {
  readonly z: number;
}

export interface FaceBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FacialFeatures {
  readonly mouthOpenRatio: number;
  readonly jawOpen: number;
  readonly browRaise: number;
  readonly browFurrow: number;
  readonly smile: number;
  readonly eyeWide: number;
}

export interface EmotionDecision {
  readonly emotion: EmotionLabel | null;
  readonly candidate: EmotionLabel | null;
  readonly confidence: number;
  readonly margin: number;
  readonly uncertain: boolean;
  readonly uncertaintyReason: UncertaintyReason | null;
  readonly probabilities: readonly number[];
}

export interface VisionResult extends EmotionDecision {
  readonly frameId: number;
  readonly timestampMs: number;
  readonly inferenceMs: number;
  readonly aiFps: number;
  readonly faceCount: number;
  readonly cameraWidth: number;
  readonly cameraHeight: number;
  readonly faceBox: FaceBox | null;
  readonly qualityIssue: QualityIssue | null;
  readonly features: FacialFeatures | null;
}

export interface CameraDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly groupId: string;
}

export interface CameraInfo {
  readonly stream: MediaStream;
  readonly deviceId: string | null;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number | null;
}

export interface CameraStartOptions {
  readonly video: HTMLVideoElement;
  readonly deviceId?: string;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
}

export interface VisionStartOptions extends CameraStartOptions {
  readonly initialAiFps?: number;
}

export interface VisionAssetUrls {
  readonly emotionModelUrl: string;
  readonly faceLandmarkerModelUrl: string;
  readonly mediaPipeWasmRoot: string;
  readonly ortWasmRoot: string;
}

export type VisionControllerEvent =
  | {
      readonly type: "status";
      readonly status: VisionStatus;
      readonly message: string;
    }
  | {
      readonly type: "result";
      readonly result: VisionResult;
      readonly provider: VisionExecutionProvider;
    }
  | {
      readonly type: "error";
      readonly message: string;
      readonly recoverable: boolean;
    };

export type VisionListener = (event: VisionControllerEvent) => void;

export const DEFAULT_CAMERA_WIDTH = 1280;
export const DEFAULT_CAMERA_HEIGHT = 720;
export const DEFAULT_CAMERA_FRAME_RATE = 30;
export const MIN_AI_FPS = 6;
export const MAX_AI_FPS = 20;
export const DEFAULT_AI_FPS = 12;

export function isEmotionLabel(value: unknown): value is EmotionLabel {
  return (
    typeof value === "string" &&
    (EMOTION_LABELS as readonly string[]).includes(value)
  );
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim() || "/";
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

export function createVisionAssetUrls(
  baseUrl: string = import.meta.env.BASE_URL,
): VisionAssetUrls {
  const base = normalizeBaseUrl(baseUrl);
  return {
    emotionModelUrl: `${base}generated/models/enet_b0_8_best_vgaf.onnx`,
    faceLandmarkerModelUrl: `${base}generated/models/face_landmarker.task`,
    mediaPipeWasmRoot: `${base}generated/mediapipe`,
    ortWasmRoot: `${base}generated/ort/`,
  };
}
