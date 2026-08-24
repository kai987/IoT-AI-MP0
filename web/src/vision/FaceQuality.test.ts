import { describe, expect, it } from "vitest";

import {
  assessFaceQuality,
  measureFaceBrightness,
  measureFaceSharpness,
} from "./FaceQuality";

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = pixel(x, y);
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data, colorSpace: "srgb" };
}

const LARGE_FACE = { x: 0, y: 0, width: 100, height: 100 } as const;

describe("FaceQuality", () => {
  it("accepts a sufficiently large, lit and sharp aligned face", () => {
    const aligned = image(9, 9, (x, y) => ((x + y) % 2 === 0 ? 48 : 208));
    const result = assessFaceQuality(aligned, LARGE_FACE);

    expect(result.issue).toBeNull();
    expect(result.brightness).toBeGreaterThan(120);
    expect(result.brightness).toBeLessThan(136);
    expect(result.sharpness).toBeGreaterThan(20);
  });

  it("reports an alignment issue for malformed image data", () => {
    const malformed: ImageData = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray(3),
      colorSpace: "srgb",
    };

    expect(assessFaceQuality(malformed, LARGE_FACE).issue).toBe("alignment");
    expect(measureFaceBrightness(malformed)).toBeNaN();
  });

  it("reports a face smaller than the 80 pixel gate", () => {
    const aligned = image(9, 9, (x, y) => ((x + y) % 2 === 0 ? 48 : 208));
    expect(
      assessFaceQuality(aligned, { x: 0, y: 0, width: 79, height: 100 }).issue,
    ).toBe("small");
  });

  it.each([0, 255])("reports lighting for a uniform value of %i", (value) => {
    const aligned = image(9, 9, () => value);
    expect(assessFaceQuality(aligned, LARGE_FACE).issue).toBe("lighting");
  });

  it("reports blur for a well-lit uniform face", () => {
    const aligned = image(9, 9, () => 128);
    expect(measureFaceSharpness(aligned)).toBe(0);
    expect(assessFaceQuality(aligned, LARGE_FACE).issue).toBe("blur");
  });
});
