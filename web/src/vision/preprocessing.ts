import { EMOTION_LABELS } from "./types";

export const EMOTION_INPUT_SIZE = 224;
export const EMOTION_INPUT_DIMS = [1, 3, 224, 224] as const;
export const EMOTION_MEAN = [0.485, 0.456, 0.406] as const;
export const EMOTION_STD = [0.229, 0.224, 0.225] as const;

export function prepareEmotionInput(imageData: ImageData): Float32Array {
  if (
    imageData.width !== EMOTION_INPUT_SIZE ||
    imageData.height !== EMOTION_INPUT_SIZE ||
    imageData.data.length !== EMOTION_INPUT_SIZE * EMOTION_INPUT_SIZE * 4
  ) {
    throw new RangeError("Emotion input must be a 224x224 RGBA image");
  }

  const planeSize = EMOTION_INPUT_SIZE * EMOTION_INPUT_SIZE;
  const tensor = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    const rgbaOffset = pixel * 4;
    const red = (imageData.data[rgbaOffset] ?? 0) / 255;
    const green = (imageData.data[rgbaOffset + 1] ?? 0) / 255;
    const blue = (imageData.data[rgbaOffset + 2] ?? 0) / 255;
    tensor[pixel] = (red - EMOTION_MEAN[0]) / EMOTION_STD[0];
    tensor[planeSize + pixel] =
      (green - EMOTION_MEAN[1]) / EMOTION_STD[1];
    tensor[2 * planeSize + pixel] =
      (blue - EMOTION_MEAN[2]) / EMOTION_STD[2];
  }
  return tensor;
}

export function validateEightClassScores(
  scores: ArrayLike<number>,
): readonly number[] {
  if (scores.length !== EMOTION_LABELS.length) {
    throw new RangeError(
      `Emotion model must return exactly ${EMOTION_LABELS.length} scores`,
    );
  }
  const values = Array.from(scores, Number);
  if (!values.every(Number.isFinite)) {
    throw new TypeError("Emotion model returned a non-finite score");
  }
  return values;
}

export function softmax(scores: ArrayLike<number>): readonly number[] {
  const values = validateEightClassScores(scores);
  const maximum = Math.max(...values);
  const exponentials = values.map((value) => Math.exp(value - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new TypeError("Emotion softmax normalization failed");
  }
  return exponentials.map((value) => value / total);
}
