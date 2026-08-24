import {
  EMOTION_LABELS,
  type EmotionDecision,
  type EmotionLabel,
  type UncertaintyReason,
  clamp,
} from "./types";
import { validateEightClassScores } from "./preprocessing";

export interface EmotionSmootherOptions {
  readonly alpha?: number;
  readonly confidenceThreshold?: number;
  readonly marginThreshold?: number;
  readonly switchConfirmations?: number;
  readonly highConfidenceSwitch?: number;
}

const DEFAULT_OPTIONS = {
  alpha: 0.55,
  confidenceThreshold: 0.45,
  marginThreshold: 0.1,
  switchConfirmations: 2,
  highConfidenceSwitch: 0.72,
} as const;

export class EmotionSmoother {
  private readonly alpha: number;
  private readonly confidenceThreshold: number;
  private readonly marginThreshold: number;
  private readonly switchConfirmations: number;
  private readonly highConfidenceSwitch: number;
  private smoothed: number[] | null = null;
  private stableIndex: number | null = null;
  private candidateIndex: number | null = null;
  private candidateCount = 0;

  public constructor(options: EmotionSmootherOptions = {}) {
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
    this.switchConfirmations = Math.max(
      1,
      Math.trunc(
        options.switchConfirmations ?? DEFAULT_OPTIONS.switchConfirmations,
      ),
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
    this.candidateCount = 0;
  }

  public update(probabilities: ArrayLike<number>): EmotionDecision {
    const input = validateEightClassScores(probabilities);
    if (input.some((value) => value < 0)) {
      throw new TypeError("Emotion probabilities cannot be negative");
    }
    const total = input.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) {
      throw new TypeError("Emotion probabilities must have a positive sum");
    }
    const normalized = input.map((value) => value / total);
    if (this.smoothed === null) {
      this.smoothed = [...normalized];
    } else {
      this.smoothed = normalized.map(
        (value, index) =>
          this.alpha * value +
          (1 - this.alpha) * (this.smoothed?.[index] ?? 0),
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
    const reliable =
      top.value >= this.confidenceThreshold && margin >= this.marginThreshold;

    if (!reliable) {
      this.stableIndex = null;
      this.candidateIndex = null;
      this.candidateCount = 0;
      return this.createDecision(
        null,
        top.index,
        top.value,
        margin,
        top.value < this.confidenceThreshold ? "low-confidence" : "low-margin",
      );
    }

    if (this.stableIndex === top.index) {
      this.candidateIndex = null;
      this.candidateCount = 0;
      return this.createDecision(top.index, null, top.value, margin, null);
    }

    if (this.candidateIndex === top.index) {
      this.candidateCount += 1;
    } else {
      this.candidateIndex = top.index;
      this.candidateCount = 1;
    }

    if (
      top.value >= this.highConfidenceSwitch ||
      this.candidateCount >= this.switchConfirmations
    ) {
      this.stableIndex = top.index;
      this.candidateIndex = null;
      this.candidateCount = 0;
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
