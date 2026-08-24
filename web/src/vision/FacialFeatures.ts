import { clamp, type FacialFeatures, type NormalizedPoint3D } from "./types";

export interface BlendshapeCategory {
  readonly categoryName: string;
  readonly score: number;
}

const UPPER_INNER_LIP_INDEX = 13;
const LOWER_INNER_LIP_INDEX = 14;
const LEFT_MOUTH_CORNER_INDEX = 61;
const RIGHT_MOUTH_CORNER_INDEX = 291;
const REQUIRED_LANDMARK_COUNT = RIGHT_MOUTH_CORNER_INDEX + 1;

function distance(a: NormalizedPoint3D, b: NormalizedPoint3D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function landmarkAt(
  landmarks: readonly NormalizedPoint3D[],
  index: number,
): NormalizedPoint3D {
  const landmark = landmarks[index];
  if (landmark === undefined) {
    throw new RangeError(`Missing face landmark at index ${index}`);
  }
  return landmark;
}

export function calculateMouthOpenRatio(
  landmarks: readonly NormalizedPoint3D[],
): number {
  if (landmarks.length < REQUIRED_LANDMARK_COUNT) {
    throw new RangeError(
      `Expected at least ${REQUIRED_LANDMARK_COUNT} face landmarks`,
    );
  }

  const lipGap = distance(
    landmarkAt(landmarks, UPPER_INNER_LIP_INDEX),
    landmarkAt(landmarks, LOWER_INNER_LIP_INDEX),
  );
  const mouthWidth = distance(
    landmarkAt(landmarks, LEFT_MOUTH_CORNER_INDEX),
    landmarkAt(landmarks, RIGHT_MOUTH_CORNER_INDEX),
  );
  return lipGap / Math.max(mouthWidth, 1e-6);
}

function createScoreLookup(
  categories: readonly BlendshapeCategory[],
): (name: string) => number {
  const scores = new Map<string, number>();
  for (const category of categories) {
    if (
      category.categoryName.length > 0 &&
      Number.isFinite(category.score)
    ) {
      scores.set(category.categoryName, category.score);
    }
  }
  return (name: string): number => scores.get(name) ?? 0;
}

export function extractFacialFeatures(
  landmarks: readonly NormalizedPoint3D[],
  categories: readonly BlendshapeCategory[],
): FacialFeatures {
  const score = createScoreLookup(categories);
  const outerBrowAverage =
    0.5 * (score("browOuterUpLeft") + score("browOuterUpRight"));

  return {
    mouthOpenRatio: calculateMouthOpenRatio(landmarks),
    jawOpen: score("jawOpen"),
    browRaise: Math.max(score("browInnerUp"), outerBrowAverage),
    browFurrow: 0.5 * (score("browDownLeft") + score("browDownRight")),
    smile: 0.5 * (score("mouthSmileLeft") + score("mouthSmileRight")),
    eyeWide: 0.5 * (score("eyeWideLeft") + score("eyeWideRight")),
  };
}

export function blendFacialFeatures(
  previous: FacialFeatures,
  newer: FacialFeatures,
  alpha = 0.45,
): FacialFeatures {
  const weight = clamp(alpha, 0, 1);
  const oldWeight = 1 - weight;
  return {
    mouthOpenRatio:
      oldWeight * previous.mouthOpenRatio + weight * newer.mouthOpenRatio,
    jawOpen: oldWeight * previous.jawOpen + weight * newer.jawOpen,
    browRaise: oldWeight * previous.browRaise + weight * newer.browRaise,
    browFurrow: oldWeight * previous.browFurrow + weight * newer.browFurrow,
    smile: oldWeight * previous.smile + weight * newer.smile,
    eyeWide: oldWeight * previous.eyeWide + weight * newer.eyeWide,
  };
}
