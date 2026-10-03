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

// 標準モードを基準に顔の占有率を比較 / 以标准模式分析宽度校准人脸占比。
export const FACE_QUALITY_REFERENCE_WIDTH = 640;
// 相対サイズを満たしても低解像度の細部を保護 / 即使满足相对尺寸，也保留最低细节像素门槛。
export const FACE_QUALITY_MINIMUM_DETAIL_PIXELS = 48;

export interface FaceQualityOptions {
  readonly frameWidth?: number;
  readonly minimumDetailPixels?: number;
  readonly workspace?: FaceQualityWorkspace;
}

// Workerごとに保持する一時領域 / 每个 Worker 独立持有工作区，不共享可变数组。
export class FaceQualityWorkspace {
  private luminance = new Float32Array(0);

  public getLuminanceBuffer(pixelCount: number): Float32Array {
    if (this.luminance.length < pixelCount) {
      this.luminance = new Float32Array(pixelCount);
    }
    return this.luminance;
  }

  public dispose(): void {
    this.luminance = new Float32Array(0);
  }
}

export const DEFAULT_FACE_QUALITY_THRESHOLDS: FaceQualityThresholds = {
  minimumFaceSize: 80,
  minimumSharpness: 20,
  minimumBrightness: 35,
  maximumBrightness: 220,
};

export function minimumFaceSizeForFrame(
  frameWidth: number,
  thresholds: FaceQualityThresholds = DEFAULT_FACE_QUALITY_THRESHOLDS,
  minimumDetailPixels = FACE_QUALITY_MINIMUM_DETAIL_PIXELS,
): number {
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) {
    throw new RangeError("Face quality frame width must be positive");
  }
  if (!Number.isFinite(minimumDetailPixels) || minimumDetailPixels <= 0) {
    throw new RangeError("Face detail size must be positive");
  }
  return Math.max(
    minimumDetailPixels,
    thresholds.minimumFaceSize * frameWidth / FACE_QUALITY_REFERENCE_WIDTH,
  );
}

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
export function measureFaceSharpness(
  imageData: ImageData,
  workspace?: FaceQualityWorkspace,
): number {
  if (!imageDataIsValid(imageData) || imageData.width < 3 || imageData.height < 3) {
    return 0;
  }
  const { width, height, data } = imageData;
  const pixelCount = width * height;
  const luminance = workspace?.getLuminanceBuffer(pixelCount) ??
    new Float32Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
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
  options: FaceQualityOptions = {},
): FaceQualityAssessment {
  if (!imageDataIsValid(imageData)) {
    return {
      issue: "alignment",
      brightness: Number.NaN,
      sharpness: Number.NaN,
    };
  }
  const minimumFaceSize = options.frameWidth === undefined
    ? thresholds.minimumFaceSize
    : minimumFaceSizeForFrame(
        options.frameWidth,
        thresholds,
        options.minimumDetailPixels,
      );
  // 安価な判定から順に実行 / 按尺寸、亮度、清晰度顺序检查，跳过已不合格帧的计算。
  if (Math.min(faceBox.width, faceBox.height) < minimumFaceSize) {
    return {
      issue: "small",
      brightness: Number.NaN,
      sharpness: Number.NaN,
    };
  }
  const brightness = measureFaceBrightness(imageData);
  if (
    brightness < thresholds.minimumBrightness ||
    brightness > thresholds.maximumBrightness
  ) {
    return { issue: "lighting", brightness, sharpness: Number.NaN };
  }
  const sharpness = measureFaceSharpness(imageData, options.workspace);
  if (sharpness < thresholds.minimumSharpness) {
    return { issue: "blur", brightness, sharpness };
  }
  return { issue: null, brightness, sharpness };
}
