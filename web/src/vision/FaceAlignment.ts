import type { NormalizedPoint3D, Point2D } from "./types";

export const FACE_ALIGNMENT_SIZE = 224;

export const ARC_FACE_TEMPLATE_224: readonly Point2D[] = [
  { x: 76.5892, y: 103.3926 },
  { x: 147.0636, y: 103.0028 },
  { x: 112.0504, y: 143.4732 },
  { x: 83.0986, y: 184.731 },
  { x: 141.4598, y: 184.4082 },
];

export interface SimilarityTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

export interface AlignedFace {
  readonly imageData: ImageData;
  readonly transform: SimilarityTransform;
}

type CanvasSurface = OffscreenCanvas | HTMLCanvasElement;
export type CanvasFactory = (width: number, height: number) => CanvasSurface;

interface AlignmentContext {
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;
  clearRect(x: number, y: number, width: number, height: number): void;
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
  putImageData(imageData: ImageData, dx: number, dy: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
}

type AlignmentImageSource = CanvasImageSource | ImageData;

const LEFT_EYE_INDICES = [33, 133] as const;
const RIGHT_EYE_INDICES = [362, 263] as const;
const NOSE_TIP_INDEX = 1;
const LEFT_MOUTH_CORNER_INDEX = 61;
const RIGHT_MOUTH_CORNER_INDEX = 291;

function pointAt(
  landmarks: readonly NormalizedPoint3D[],
  index: number,
): NormalizedPoint3D {
  const point = landmarks[index];
  if (point === undefined) {
    throw new RangeError(`Missing face landmark at index ${index}`);
  }
  return point;
}

function meanPoint(
  landmarks: readonly NormalizedPoint3D[],
  firstIndex: number,
  secondIndex: number,
): Point2D {
  const first = pointAt(landmarks, firstIndex);
  const second = pointAt(landmarks, secondIndex);
  return {
    x: 0.5 * (first.x + second.x),
    y: 0.5 * (first.y + second.y),
  };
}

function toPixels(point: Point2D, width: number, height: number): Point2D {
  return { x: point.x * width, y: point.y * height };
}

/** Extracts ArcFace eye, nose and mouth points ordered from screen-left. */
export function extractArcFaceFivePoints(
  landmarks: readonly NormalizedPoint3D[],
  imageWidth: number,
  imageHeight: number,
): readonly Point2D[] {
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw new RangeError("Image dimensions must be positive");
  }

  const eyes = [
    meanPoint(landmarks, LEFT_EYE_INDICES[0], LEFT_EYE_INDICES[1]),
    meanPoint(landmarks, RIGHT_EYE_INDICES[0], RIGHT_EYE_INDICES[1]),
  ].sort((left, right) => left.x - right.x);
  const mouth = [
    pointAt(landmarks, LEFT_MOUTH_CORNER_INDEX),
    pointAt(landmarks, RIGHT_MOUTH_CORNER_INDEX),
  ].sort((left, right) => left.x - right.x);
  const leftEye = eyes[0];
  const rightEye = eyes[1];
  const leftMouth = mouth[0];
  const rightMouth = mouth[1];
  if (
    leftEye === undefined ||
    rightEye === undefined ||
    leftMouth === undefined ||
    rightMouth === undefined
  ) {
    throw new RangeError("Unable to extract five face landmarks");
  }

  return [
    toPixels(leftEye, imageWidth, imageHeight),
    toPixels(rightEye, imageWidth, imageHeight),
    toPixels(pointAt(landmarks, NOSE_TIP_INDEX), imageWidth, imageHeight),
    toPixels(leftMouth, imageWidth, imageHeight),
    toPixels(rightMouth, imageWidth, imageHeight),
  ];
}

/** Least-squares 2D similarity transform: target = scale * R * source + t. */
export function estimateSimilarityTransform(
  source: readonly Point2D[],
  target: readonly Point2D[] = ARC_FACE_TEMPLATE_224,
): SimilarityTransform | null {
  if (source.length !== target.length || source.length < 2) {
    throw new RangeError("Source and target point counts must match");
  }
  if (
    !source.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)) ||
    !target.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  ) {
    return null;
  }

  const count = source.length;
  const sourceCenter = source.reduce(
    (sum, point) => ({ x: sum.x + point.x / count, y: sum.y + point.y / count }),
    { x: 0, y: 0 },
  );
  const targetCenter = target.reduce(
    (sum, point) => ({ x: sum.x + point.x / count, y: sum.y + point.y / count }),
    { x: 0, y: 0 },
  );

  let denominator = 0;
  let realNumerator = 0;
  let imaginaryNumerator = 0;
  for (let index = 0; index < count; index += 1) {
    const sourcePoint = source[index];
    const targetPoint = target[index];
    if (sourcePoint === undefined || targetPoint === undefined) {
      return null;
    }
    const sx = sourcePoint.x - sourceCenter.x;
    const sy = sourcePoint.y - sourceCenter.y;
    const tx = targetPoint.x - targetCenter.x;
    const ty = targetPoint.y - targetCenter.y;
    denominator += sx * sx + sy * sy;
    realNumerator += sx * tx + sy * ty;
    imaginaryNumerator += sx * ty - sy * tx;
  }

  if (!Number.isFinite(denominator) || denominator <= 1e-8) {
    return null;
  }
  const a = realNumerator / denominator;
  const b = imaginaryNumerator / denominator;
  const tx = targetCenter.x - (a * sourceCenter.x - b * sourceCenter.y);
  const ty = targetCenter.y - (b * sourceCenter.x + a * sourceCenter.y);
  if (![a, b, tx, ty].every(Number.isFinite)) {
    return null;
  }
  return { a, b, c: -b, d: a, tx, ty };
}

export function transformPoint(
  transform: SimilarityTransform,
  point: Point2D,
): Point2D {
  return {
    x: transform.a * point.x + transform.c * point.y + transform.tx,
    y: transform.b * point.x + transform.d * point.y + transform.ty,
  };
}

function defaultCanvasFactory(width: number, height: number): CanvasSurface {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("A 2D canvas is required for face alignment");
}

export function alignFace(
  image: AlignmentImageSource,
  fivePoints: readonly Point2D[],
  canvasFactory: CanvasFactory = defaultCanvasFactory,
): AlignedFace | null {
  const transform = estimateSimilarityTransform(fivePoints);
  if (transform === null) {
    return null;
  }
  let drawSource: CanvasImageSource = image as CanvasImageSource;
  if ("data" in image && image.data instanceof Uint8ClampedArray) {
    const sourceCanvas = canvasFactory(image.width, image.height);
    const sourceContext = sourceCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    }) as AlignmentContext | null;
    if (sourceContext === null) {
      throw new Error("Unable to create a 2D source context");
    }
    sourceContext.putImageData(image, 0, 0);
    drawSource = sourceCanvas;
  }

  const canvas = canvasFactory(FACE_ALIGNMENT_SIZE, FACE_ALIGNMENT_SIZE);
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  }) as AlignmentContext | null;
  if (context === null) {
    throw new Error("Unable to create a 2D alignment context");
  }

  context.clearRect(0, 0, FACE_ALIGNMENT_SIZE, FACE_ALIGNMENT_SIZE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.setTransform(
    transform.a,
    transform.b,
    transform.c,
    transform.d,
    transform.tx,
    transform.ty,
  );
  context.drawImage(drawSource, 0, 0);
  return {
    imageData: context.getImageData(
      0,
      0,
      FACE_ALIGNMENT_SIZE,
      FACE_ALIGNMENT_SIZE,
    ),
    transform,
  };
}
