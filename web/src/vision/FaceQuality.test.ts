import { describe, expect, it, vi } from "vitest";

import {
  assessFaceQuality,
  DEFAULT_FACE_QUALITY_THRESHOLDS,
  FaceQualityWorkspace,
  measureFaceBrightness,
  measureFaceSharpness,
  minimumFaceSizeForFrame,
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

  it.each([480, 640, 960])("applies the same relative face-size gate at width %i", (frameWidth) => {
    const aligned = image(9, 9, (x, y) => ((x + y) % 2 === 0 ? 48 : 208));
    const assess = (sizeAt640: number) => assessFaceQuality(
      aligned,
      { x: 0, y: 0, width: sizeAt640 * frameWidth / 640, height: sizeAt640 * frameWidth / 640 },
      DEFAULT_FACE_QUALITY_THRESHOLDS,
      { frameWidth },
    );
    expect(minimumFaceSizeForFrame(frameWidth)).toBe(80 * frameWidth / 640);
    expect(assess(80).issue).toBeNull();
    expect(assess(79).issue).toBe("small");
  });

  it("protects minimum pixel detail when a small frame passes the relative gate", () => {
    const aligned = image(9, 9, (x, y) => ((x + y) % 2 === 0 ? 48 : 208));
    expect(minimumFaceSizeForFrame(320)).toBe(48);
    expect(assessFaceQuality(
      aligned,
      { x: 0, y: 0, width: 40, height: 40 },
      DEFAULT_FACE_QUALITY_THRESHOLDS,
      { frameWidth: 320 },
    ).issue).toBe("small");
    expect(() => minimumFaceSizeForFrame(0)).toThrow(/positive/);
  });

  it("skips brightness and sharpness for small faces, and sharpness for poor lighting", () => {
    const workspace = new FaceQualityWorkspace();
    const luminance = vi.spyOn(workspace, "getLuminanceBuffer");
    const small = assessFaceQuality(
      image(9, 9, () => 0),
      { x: 0, y: 0, width: 79, height: 100 },
      DEFAULT_FACE_QUALITY_THRESHOLDS,
      { workspace },
    );
    expect(small.issue).toBe("small");
    expect(small.brightness).toBeNaN();
    expect(small.sharpness).toBeNaN();
    const dark = assessFaceQuality(image(9, 9, () => 0), LARGE_FACE,
      DEFAULT_FACE_QUALITY_THRESHOLDS, { workspace });
    expect(dark.issue).toBe("lighting");
    expect(dark.brightness).toBe(0);
    expect(dark.sharpness).toBeNaN();
    expect(luminance).not.toHaveBeenCalled();
  });

  it("reuses luminance storage without including stale pixels when dimensions shrink", () => {
    const workspace = new FaceQualityWorkspace();
    const large = image(20, 20, (x, y) => ((x + y) % 2 === 0 ? 48 : 208));
    const small = image(9, 9, () => 128);
    expect(measureFaceSharpness(large, workspace)).toBe(measureFaceSharpness(large));
    const buffer = workspace.getLuminanceBuffer(400);
    expect(measureFaceSharpness(small, workspace)).toBe(0);
    expect(workspace.getLuminanceBuffer(81)).toBe(buffer);
    expect(new FaceQualityWorkspace().getLuminanceBuffer(400)).not.toBe(buffer);
    workspace.dispose();
    expect(workspace.getLuminanceBuffer(400)).not.toBe(buffer);
  });
});
