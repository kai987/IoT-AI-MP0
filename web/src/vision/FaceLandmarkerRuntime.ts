import type {
  Category,
  FaceLandmarker,
  FaceLandmarkerResult,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";

import {
  extractFacialFeatures,
  type BlendshapeCategory,
} from "./FacialFeatures";
import { extractArcFaceFivePoints } from "./FaceAlignment";
import { resolveLocalAssetUrl } from "./EmotionClassifier";
import { clamp, type FaceBox, type FacialFeatures, type Point2D } from "./types";

type MediaPipeModule = typeof import("@mediapipe/tasks-vision");

export interface FaceLandmarkerRuntimeOptions {
  readonly modelUrl: string;
  readonly wasmRoot: string;
  readonly mediaPipe?: MediaPipeModule;
  readonly preferGpu?: boolean;
}

export interface SelectedLandmarkerFace {
  readonly landmarks: readonly NormalizedLandmark[];
  readonly blendshapes: readonly BlendshapeCategory[];
  readonly normalizedBox: FaceBox;
  readonly pixelBox: FaceBox;
  readonly fivePoints: readonly Point2D[];
  readonly features: FacialFeatures;
}

export interface FaceLandmarkerDetection {
  readonly faceCount: number;
  readonly primaryFace: SelectedLandmarkerFace | null;
}

function validCoordinate(value: number): boolean {
  return Number.isFinite(value);
}

export function calculateLandmarkBounds(
  landmarks: readonly NormalizedLandmark[],
): FaceBox | null {
  if (landmarks.length === 0) {
    return null;
  }
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const landmark of landmarks) {
    if (!validCoordinate(landmark.x) || !validCoordinate(landmark.y)) {
      continue;
    }
    minimumX = Math.min(minimumX, landmark.x);
    minimumY = Math.min(minimumY, landmark.y);
    maximumX = Math.max(maximumX, landmark.x);
    maximumY = Math.max(maximumY, landmark.y);
  }
  if (![minimumX, minimumY, maximumX, maximumY].every(Number.isFinite)) {
    return null;
  }
  const left = clamp(minimumX, 0, 1);
  const top = clamp(minimumY, 0, 1);
  const right = clamp(maximumX, 0, 1);
  const bottom = clamp(maximumY, 0, 1);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function selectLargestFaceIndex(
  faces: readonly (readonly NormalizedLandmark[])[],
): number | null {
  let selectedIndex: number | null = null;
  let selectedArea = -1;
  for (let index = 0; index < faces.length; index += 1) {
    const face = faces[index];
    if (face === undefined) {
      continue;
    }
    const box = calculateLandmarkBounds(face);
    if (box === null) {
      continue;
    }
    const area = box.width * box.height;
    if (area > selectedArea) {
      selectedArea = area;
      selectedIndex = index;
    }
  }
  return selectedIndex;
}

function toPixelBox(box: FaceBox, width: number, height: number): FaceBox {
  return {
    x: box.x * width,
    y: box.y * height,
    width: box.width * width,
    height: box.height * height,
  };
}

function categoriesForFace(
  result: FaceLandmarkerResult,
  faceIndex: number,
): readonly Category[] {
  return result.faceBlendshapes[faceIndex]?.categories ?? [];
}

export class FaceLandmarkerRuntime {
  public readonly delegate: "GPU" | "CPU";
  private readonly landmarker: FaceLandmarker;
  private lastTimestampMs = -1;
  private closed = false;

  private constructor(landmarker: FaceLandmarker, delegate: "GPU" | "CPU") {
    this.landmarker = landmarker;
    this.delegate = delegate;
  }

  public static async create(
    options: FaceLandmarkerRuntimeOptions,
  ): Promise<FaceLandmarkerRuntime> {
    const mediaPipe =
      options.mediaPipe ?? (await import("@mediapipe/tasks-vision"));
    const modelUrl = resolveLocalAssetUrl(options.modelUrl);
    const wasmRoot = resolveLocalAssetUrl(options.wasmRoot);
    // This code runs inside an ES module Worker, so request MediaPipe's ESM
    // loader. The classic loader depends on importScripts() and cannot expose
    // its ModuleFactory when it is imported by a module Worker.
    const fileset = await mediaPipe.FilesetResolver.forVisionTasks(
      wasmRoot,
      true,
    );

    const create = async (delegate: "GPU" | "CPU"): Promise<FaceLandmarker> => {
      const canvas =
        delegate === "GPU" && typeof OffscreenCanvas !== "undefined"
          ? new OffscreenCanvas(1, 1)
          : undefined;
      return mediaPipe.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate },
        runningMode: "VIDEO",
        numFaces: 4,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
        ...(canvas === undefined ? {} : { canvas }),
      });
    };

    if (options.preferGpu ?? true) {
      try {
        return new FaceLandmarkerRuntime(await create("GPU"), "GPU");
      } catch {
        // Some worker/browser combinations cannot create a GPU delegate.
      }
    }
    return new FaceLandmarkerRuntime(await create("CPU"), "CPU");
  }

  public detect(
    frame: ImageBitmap | ImageData,
    timestampMs: number,
  ): FaceLandmarkerDetection {
    if (this.closed) {
      throw new Error("Face Landmarker is closed");
    }
    const monotonicTimestamp = Math.max(timestampMs, this.lastTimestampMs + 0.001);
    this.lastTimestampMs = monotonicTimestamp;
    const result = this.landmarker.detectForVideo(frame, monotonicTimestamp);
    const selectedIndex = selectLargestFaceIndex(result.faceLandmarks);
    if (selectedIndex === null) {
      return { faceCount: result.faceLandmarks.length, primaryFace: null };
    }
    const landmarks = result.faceLandmarks[selectedIndex];
    if (landmarks === undefined) {
      return { faceCount: result.faceLandmarks.length, primaryFace: null };
    }
    const normalizedBox = calculateLandmarkBounds(landmarks);
    if (normalizedBox === null) {
      return { faceCount: result.faceLandmarks.length, primaryFace: null };
    }
    const categories = categoriesForFace(result, selectedIndex);
    const blendshapes = categories.map((category) => ({
      categoryName: category.categoryName,
      score: category.score,
    }));
    return {
      faceCount: result.faceLandmarks.length,
      primaryFace: {
        landmarks,
        blendshapes,
        normalizedBox,
        pixelBox: toPixelBox(normalizedBox, frame.width, frame.height),
        fivePoints: extractArcFaceFivePoints(
          landmarks,
          frame.width,
          frame.height,
        ),
        features: extractFacialFeatures(landmarks, blendshapes),
      },
    };
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.landmarker.close();
  }
}
