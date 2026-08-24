import { describe, expect, it } from "vitest";

import {
  blendFacialFeatures,
  calculateMouthOpenRatio,
  extractFacialFeatures,
} from "./FacialFeatures";
import type { NormalizedPoint3D } from "./types";

function landmarks(): NormalizedPoint3D[] {
  const result = new Array<NormalizedPoint3D>(478).fill({ x: 0, y: 0, z: 0 });
  result[13] = { x: 0.5, y: 0.45, z: 0 };
  result[14] = { x: 0.5, y: 0.55, z: 0 };
  result[61] = { x: 0.25, y: 0.5, z: 0 };
  result[291] = { x: 0.75, y: 0.5, z: 0 };
  return result;
}

describe("FacialFeatures", () => {
  it("normalizes the inner lip gap by mouth width", () => {
    expect(calculateMouthOpenRatio(landmarks())).toBeCloseTo(0.2);
  });

  it("maps MediaPipe blendshapes to game features", () => {
    const features = extractFacialFeatures(landmarks(), [
      { categoryName: "jawOpen", score: 0.4 },
      { categoryName: "browInnerUp", score: 0.3 },
      { categoryName: "browDownLeft", score: 0.8 },
      { categoryName: "browDownRight", score: 0.6 },
      { categoryName: "mouthSmileLeft", score: 0.5 },
      { categoryName: "mouthSmileRight", score: 0.3 },
      { categoryName: "eyeWideLeft", score: 0.2 },
      { categoryName: "eyeWideRight", score: 0.4 },
    ]);

    expect(features.jawOpen).toBe(0.4);
    expect(features.browRaise).toBe(0.3);
    expect(features.browFurrow).toBeCloseTo(0.7);
    expect(features.smile).toBeCloseTo(0.4);
    expect(features.eyeWide).toBeCloseTo(0.3);
  });

  it("smooths facial features with an EMA", () => {
    const previous = extractFacialFeatures(landmarks(), []);
    const newer = { ...previous, jawOpen: 1, smile: 1 };
    const blended = blendFacialFeatures(previous, newer, 0.25);
    expect(blended.jawOpen).toBe(0.25);
    expect(blended.smile).toBe(0.25);
  });
});
