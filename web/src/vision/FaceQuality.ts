import type { FaceBox, QualityIssue } from "./types";

export interface FaceQualityThresholds {
  readonly minimumFaceSize: number;
  readonly minimumSharpness: number;
  readonly minimumBrightness: number;
  readonly maximumBrightness: number;
}

export interface FaceQualityAssessment {
  readonly issue: QualityIssue | null;
  readonly brightness: number;
  readonly sharpness: number;
}

export const DEFAULT_FACE_QUALITY_THRESHOLDS: FaceQualityThresholds = {
  minimumFaceSize: 80,
  minimumSharpness: 20,
  minimumBrightness: 35,
  maximumBrightness: 220,
};

function imageDataIsValid(imageData: ImageData): boolean {
  return (
    imageData.width > 0 &&
    imageData.height > 0 &&
    imageData.data.length === imageData.width * imageData.height * 4
  );
}

export function measureFaceBrightness(imageData: ImageData): number {
  if (!imageDataIsValid(imageData)) {
    return Number.NaN;
  }
  let total = 0;
  const pixels = imageData.data;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    total += 0.299 * red + 0.587 * green + 0.114 * blue;
  }
  return total / (imageData.width * imageData.height);
}

/** Variance of a four-neighbour Laplacian, matching OpenCV's blur gate. */
export function measureFaceSharpness(imageData: ImageData): number {
  if (!imageDataIsValid(imageData) || imageData.width < 3 || imageData.height < 3) {
    return 0;
  }
  const { width, height, data } = imageData;
  const luminance = new Float32Array(width * height);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    luminance[index] =
      0.299 * (data[offset] ?? 0) +
      0.587 * (data[offset + 1] ?? 0) +
      0.114 * (data[offset + 2] ?? 0);
  }

  let sum = 0;
  let sumOfSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const centerIndex = y * width + x;
      const center = luminance[centerIndex] ?? 0;
      const laplacian =
        (luminance[centerIndex - 1] ?? 0) +
        (luminance[centerIndex + 1] ?? 0) +
        (luminance[centerIndex - width] ?? 0) +
        (luminance[centerIndex + width] ?? 0) -
        4 * center;
      sum += laplacian;
      sumOfSquares += laplacian * laplacian;
      count += 1;
    }
  }
  if (count === 0) {
    return 0;
  }
  const mean = sum / count;
  return Math.max(0, sumOfSquares / count - mean * mean);
}

export function assessFaceQuality(
  imageData: ImageData,
  faceBox: FaceBox,
  thresholds: FaceQualityThresholds = DEFAULT_FACE_QUALITY_THRESHOLDS,
): FaceQualityAssessment {
  if (!imageDataIsValid(imageData)) {
    return {
      issue: "alignment",
      brightness: Number.NaN,
      sharpness: Number.NaN,
    };
  }
  const brightness = measureFaceBrightness(imageData);
  const sharpness = measureFaceSharpness(imageData);
  if (Math.min(faceBox.width, faceBox.height) < thresholds.minimumFaceSize) {
    return { issue: "small", brightness, sharpness };
  }
  if (
    brightness < thresholds.minimumBrightness ||
    brightness > thresholds.maximumBrightness
  ) {
    return { issue: "lighting", brightness, sharpness };
  }
  if (sharpness < thresholds.minimumSharpness) {
    return { issue: "blur", brightness, sharpness };
  }
  return { issue: null, brightness, sharpness };
}
