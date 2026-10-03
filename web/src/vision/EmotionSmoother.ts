import {
  EMOTION_LABELS,
  type EmotionDecision,
  type EmotionLabel,
  type UncertaintyReason,
  clamp,
} from "./types";
import { validateEightClassScores } from "./preprocessing";
import { VISION_STABILITY } from "../RuntimeSettings";

export interface EmotionSmootherOptions {
  readonly emotionThresholds?: Partial<Record<EmotionLabel, number>>;
  readonly alpha?: number;
  readonly confidenceThreshold?: number;
  readonly marginThreshold?: number;
  readonly switchConfirmations?: number;
  readonly switchConfirmationMs?: number;
  readonly highConfidenceSwitch?: number;
}

/** 時間に応じたEMA係数 / 按采样间隔换算EMA权重，不随AI FPS改变平滑速度。 */
export function timeAdjustedAlpha(alpha: number, elapsedMs: number): number {
  const weight = clamp(alpha, 0, 1);
  if (elapsedMs <= 0 || !Number.isFinite(elapsedMs)) return 0;
  return 1 - Math.pow(1 - weight, elapsedMs / VISION_STABILITY.referenceIntervalMs);
}

const DEFAULT_OPTIONS = {
  alpha: 0.55,
  confidenceThreshold: 0.45,
  marginThreshold: 0.1,
  highConfidenceSwitch: 0.72,
} as const;

export class EmotionSmoother {
  private readonly alpha: number;
  private readonly confidenceThreshold: number;
  private readonly marginThreshold: number;
  private readonly switchConfirmationMs: number;
  private readonly highConfidenceSwitch: number;
  private smoothed: number[] | null = null;
  private stableIndex: number | null = null;
  private candidateIndex: number | null = null;
  private candidateSinceMs: number | null = null;
  private lastTimestampMs: number | null = null;
  private readonly emotionThresholds: Partial<Record<EmotionLabel, number>>;

  public constructor(options: EmotionSmootherOptions = {}) {
    this.emotionThresholds = { ...options.emotionThresholds };
    this.alpha = clamp(options.alpha ?? DEFAULT_OPTIONS.alpha, 0, 1);
    this.confidenceThreshold = clamp(
      options.confidenceThreshold ?? DEFAULT_OPTIONS.confidenceThreshold,
      0,
      1,
    );
    this.marginThreshold = clamp(
      options.marginThreshold ?? DEFAULT_OPTIONS.marginThreshold,
      0,
      1,
    );
    // 旧設定との互換性 / 旧确认帧数按12 FPS换算为持续时间，工作线程传入真实采集时刻。
    this.switchConfirmationMs = Math.max(0,
      options.switchConfirmationMs ??
      (options.switchConfirmations === undefined ? VISION_STABILITY.switchConfirmationMs :
        (Math.max(1, Math.trunc(options.switchConfirmations)) - 1) * VISION_STABILITY.referenceIntervalMs),
    );
    this.highConfidenceSwitch = clamp(
      options.highConfidenceSwitch ?? DEFAULT_OPTIONS.highConfidenceSwitch,
      0,
      1,
    );
  }

  public reset(): void {
    this.smoothed = null;
    this.stableIndex = null;
    this.candidateIndex = null;
    this.candidateSinceMs = null;
    this.lastTimestampMs = null;
  }

  public update(probabilities: ArrayLike<number>, timestampMs?: number): EmotionDecision {
    const input = validateEightClassScores(probabilities);
    if (input.some((value) => value < 0)) {
      throw new TypeError("Emotion probabilities cannot be negative");
    }
    const total = input.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) {
      throw new TypeError("Emotion probabilities must have a positive sum");
    }
    const normalized = input.map((value) => value / total);
    const timestamp = timestampMs ?? (this.lastTimestampMs === null ? 0 : this.lastTimestampMs + VISION_STABILITY.referenceIntervalMs);
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new TypeError("Emotion timestamp must be finite and non-negative");
    }
    if (this.lastTimestampMs !== null && timestamp < this.lastTimestampMs) {
      throw new RangeError("Emotion timestamps must be monotonic");
    }
    const elapsedMs = this.lastTimestampMs === null ? VISION_STABILITY.referenceIntervalMs : timestamp - this.lastTimestampMs;
    if (elapsedMs > VISION_STABILITY.sampleGapResetMs) this.reset();
    this.lastTimestampMs = timestamp;
    if (this.smoothed === null) {
      this.smoothed = [...normalized];
    } else {
      const alpha = timeAdjustedAlpha(this.alpha, elapsedMs);
      this.smoothed = normalized.map(
        (value, index) =>
          alpha * value +
          (1 - alpha) * (this.smoothed?.[index] ?? 0),
      );
    }

    const ranking = this.smoothed
      .map((value, index) => ({ value, index }))
      .sort((left, right) => right.value - left.value);
    const top = ranking[0];
    const second = ranking[1];
    if (top === undefined || second === undefined) {
      throw new Error("Emotion ranking requires eight classes");
    }
    const margin = top.value - second.value;
    const label = EMOTION_LABELS[top.index];
    const threshold = label === undefined ? this.confidenceThreshold : (this.emotionThresholds[label] ?? this.confidenceThreshold);
    const reliable =
      top.value >= threshold && margin >= this.marginThreshold;

    if (!reliable) {
      this.stableIndex = null;
      this.candidateIndex = null;
      this.candidateSinceMs = null;
      return this.createDecision(
        null,
        top.index,
        top.value,
        margin,
        top.value < threshold ? "low-confidence" : "low-margin",
      );
    }

    if (this.stableIndex === top.index) {
      this.candidateIndex = null;
      this.candidateSinceMs = null;
      return this.createDecision(top.index, null, top.value, margin, null);
    }

    if (this.candidateIndex !== top.index) {
      this.candidateIndex = top.index;
      this.candidateSinceMs = timestamp;
    }

    if (
      top.value >= this.highConfidenceSwitch ||
      timestamp - (this.candidateSinceMs ?? timestamp) + 1e-6 >= this.switchConfirmationMs
    ) {
      this.stableIndex = top.index;
      this.candidateIndex = null;
      this.candidateSinceMs = null;
      return this.createDecision(top.index, null, top.value, margin, null);
    }

    if (this.stableIndex !== null) {
      const stableConfidence = this.smoothed[this.stableIndex] ?? 0;
      return this.createDecision(
        this.stableIndex,
        null,
        stableConfidence,
        margin,
        null,
      );
    }
    return this.createDecision(
      null,
      top.index,
      top.value,
      margin,
      "switch-pending",
    );
  }

  private createDecision(
    emotionIndex: number | null,
    candidateIndex: number | null,
    confidence: number,
    margin: number,
    uncertaintyReason: UncertaintyReason | null,
  ): EmotionDecision {
    const emotion = this.labelAt(emotionIndex);
    const candidate = this.labelAt(candidateIndex);
    return {
      emotion,
      candidate,
      confidence,
      margin,
      uncertain: emotion === null,
      uncertaintyReason,
      probabilities: [...(this.smoothed ?? new Array<number>(8).fill(0))],
    };
  }

  private labelAt(index: number | null): EmotionLabel | null {
    if (index === null) {
      return null;
    }
    return EMOTION_LABELS[index] ?? null;
  }
}
