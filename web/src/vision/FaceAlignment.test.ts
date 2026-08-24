import { describe, expect, it } from "vitest";

import {
  ARC_FACE_TEMPLATE_224,
  estimateSimilarityTransform,
  extractArcFaceFivePoints,
  transformPoint,
} from "./FaceAlignment";
import type { NormalizedPoint3D, Point2D } from "./types";

describe("FaceAlignment", () => {
  const base: readonly Point2D[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 2, y: 2 },
    { x: 1, y: 5 },
    { x: 3, y: 5 },
  ];

  it.each([
    ["identity", { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }],
    ["translation", { a: 1, b: 0, c: 0, d: 1, tx: 8, ty: -3 }],
    ["uniform scale", { a: 2.5, b: 0, c: 0, d: 2.5, tx: 0, ty: 0 }],
    ["rotation", { a: 0, b: 1, c: -1, d: 0, tx: 10, ty: 2 }],
  ] as const)("recovers a %s similarity transform", (_name, expected) => {
    const target = base.map((point) => transformPoint(expected, point));
    const estimated = estimateSimilarityTransform(base, target);

    expect(estimated).not.toBeNull();
    expect(estimated?.a).toBeCloseTo(expected.a, 10);
    expect(estimated?.b).toBeCloseTo(expected.b, 10);
    expect(estimated?.c).toBeCloseTo(expected.c, 10);
    expect(estimated?.d).toBeCloseTo(expected.d, 10);
    expect(estimated?.tx).toBeCloseTo(expected.tx, 10);
    expect(estimated?.ty).toBeCloseTo(expected.ty, 10);
  });

  it("recovers a scale, rotation and translation transform", () => {
    const source: Point2D[] = [
      { x: 1, y: 2 },
      { x: 5, y: 2 },
      { x: 3, y: 4 },
      { x: 2, y: 7 },
      { x: 4, y: 7 },
    ];
    const expected = { a: 1.2, b: 0.35, c: -0.35, d: 1.2, tx: 8, ty: -4 };
    const target = source.map((point) => transformPoint(expected, point));
    const estimated = estimateSimilarityTransform(source, target);

    expect(estimated).not.toBeNull();
    for (const [index, point] of source.entries()) {
      const transformed = transformPoint(estimated!, point);
      expect(transformed.x).toBeCloseTo(target[index]?.x ?? 0, 8);
      expect(transformed.y).toBeCloseTo(target[index]?.y ?? 0, 8);
    }
  });

  it("extracts screen-left ordered ArcFace points in pixels", () => {
    const landmarks = new Array<NormalizedPoint3D>(478).fill({ x: 0.5, y: 0.5, z: 0 });
    landmarks[33] = { x: 0.75, y: 0.3, z: 0 };
    landmarks[133] = { x: 0.65, y: 0.3, z: 0 };
    landmarks[362] = { x: 0.25, y: 0.3, z: 0 };
    landmarks[263] = { x: 0.35, y: 0.3, z: 0 };
    landmarks[1] = { x: 0.5, y: 0.5, z: 0 };
    landmarks[61] = { x: 0.65, y: 0.7, z: 0 };
    landmarks[291] = { x: 0.35, y: 0.7, z: 0 };

    const points = extractArcFaceFivePoints(landmarks, 1000, 500);
    expect(points[0]).toEqual({ x: 300, y: 150 });
    expect(points[1]).toEqual({ x: 700, y: 150 });
    expect(points[2]).toEqual({ x: 500, y: 250 });
    expect(points[3]).toEqual({ x: 350, y: 350 });
    expect(points[4]).toEqual({ x: 650, y: 350 });
  });

  it("matches the precomputed Python least-squares ArcFace matrix", () => {
    const source: Point2D[] = [
      { x: 30, y: 40 },
      { x: 80, y: 40 },
      { x: 55, y: 70 },
      { x: 37, y: 95 },
      { x: 73, y: 95 },
    ];
    const transform = estimateSimilarityTransform(source, ARC_FACE_TEMPLATE_224);

    expect(transform).not.toBeNull();
    expect(transform?.a).toBeCloseTo(1.4786922077922078, 10);
    expect(transform?.b).toBeCloseTo(-0.008209131493506511, 10);
    expect(transform?.c).toBeCloseTo(0.008209131493506511, 10);
    expect(transform?.d).toBeCloseTo(1.4786922077922078, 10);
    expect(transform?.tx).toBeCloseTo(30.16602762987013, 10);
    expect(transform?.ty).toBeCloseTo(43.701992102272726, 10);
  });

  it("returns null for degenerate or non-finite points", () => {
    const collapsed = new Array<Point2D>(5).fill({ x: 2, y: 2 });
    expect(estimateSimilarityTransform(collapsed, base)).toBeNull();
    expect(
      estimateSimilarityTransform(
        [{ x: Number.NaN, y: 0 }, ...base.slice(1)],
        base,
      ),
    ).toBeNull();
  });
});
