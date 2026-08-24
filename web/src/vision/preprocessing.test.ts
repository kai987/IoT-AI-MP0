import { describe, expect, it } from "vitest";

import {
  EMOTION_INPUT_SIZE,
  prepareEmotionInput,
  softmax,
} from "./preprocessing";

function constantImage(value: number): ImageData {
  const data = new Uint8ClampedArray(
    EMOTION_INPUT_SIZE * EMOTION_INPUT_SIZE * 4,
  );
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return {
    width: EMOTION_INPUT_SIZE,
    height: EMOTION_INPUT_SIZE,
    data,
    colorSpace: "srgb",
  };
}

describe("emotion preprocessing", () => {
  it("creates normalized RGB CHW data matching the Python model input", () => {
    const tensor = prepareEmotionInput(constantImage(127));
    const plane = EMOTION_INPUT_SIZE * EMOTION_INPUT_SIZE;

    expect(tensor).toHaveLength(plane * 3);
    expect(tensor[0]).toBeCloseTo((127 / 255 - 0.485) / 0.229, 6);
    expect(tensor[plane]).toBeCloseTo((127 / 255 - 0.456) / 0.224, 6);
    expect(tensor[2 * plane]).toBeCloseTo((127 / 255 - 0.406) / 0.225, 6);
  });

  it("uses a numerically stable eight-class softmax", () => {
    const probabilities = softmax([1001, 1000, 999, 998, 997, 996, 995, 994]);

    expect(probabilities).toHaveLength(8);
    expect(probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(probabilities[0]).toBeGreaterThan(probabilities[1] ?? 0);
  });

  it("rejects malformed model output", () => {
    expect(() => softmax([1, 2])).toThrow(/exactly 8/);
    expect(() => softmax([1, 2, 3, 4, 5, 6, 7, Number.NaN])).toThrow(
      /non-finite/,
    );
  });
});
