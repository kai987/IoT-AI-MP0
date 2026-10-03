import { describe, expect, it } from "vitest";

import { EmotionSmoother } from "./EmotionSmoother";

function probabilities(topIndex: number, topValue: number): number[] {
  const remainder = (1 - topValue) / 7;
  return new Array<number>(8)
    .fill(remainder)
    .map((value, index) => (index === topIndex ? topValue : value));
}

describe("EmotionSmoother", () => {
  it("honors a separate threshold for each calibrated expression", () => {
    const smoother = new EmotionSmoother({ emotionThresholds: { happiness: 0.8, surprise: 0.4 }, alpha: 1, switchConfirmations: 1 });
    expect(smoother.update(probabilities(4, 0.75)).uncertain).toBe(true);
    expect(smoother.update(probabilities(7, 0.5)).emotion).toBe("surprise");
    expect(smoother.update(probabilities(4, 0.85)).emotion).toBe("happiness");
  });
  it("requires two moderate-confidence confirmations", () => {
    const smoother = new EmotionSmoother();
    const first = smoother.update(probabilities(4, 0.65));
    const second = smoother.update(probabilities(4, 0.65));

    expect(first.emotion).toBeNull();
    expect(first.candidate).toBe("happiness");
    expect(first.uncertaintyReason).toBe("switch-pending");
    expect(second.emotion).toBe("happiness");
    expect(second.uncertain).toBe(false);
  });

  it("switches immediately at high confidence", () => {
    const decision = new EmotionSmoother().update(probabilities(7, 0.8));
    expect(decision.emotion).toBe("surprise");
    expect(decision.uncertaintyReason).toBeNull();
  });

  it("reports low confidence instead of forcing a class", () => {
    const decision = new EmotionSmoother().update(probabilities(5, 0.3));
    expect(decision.emotion).toBeNull();
    expect(decision.candidate).toBe("neutral");
    expect(decision.uncertaintyReason).toBe("low-confidence");
  });

  it("reports a low margin when the leading classes are too close", () => {
    const decision = new EmotionSmoother().update([
      0.46, 0.44, 0.02, 0.02, 0.02, 0.02, 0.01, 0.01,
    ]);

    expect(decision.emotion).toBeNull();
    expect(decision.uncertaintyReason).toBe("low-margin");
  });

  it("rejects non-eight-class and non-finite probability vectors", () => {
    const smoother = new EmotionSmoother();
    expect(() => smoother.update([1, 0])).toThrow(/exactly 8/);
    expect(() =>
      smoother.update([1, 0, 0, 0, 0, 0, 0, Number.NaN]),
    ).toThrow(/non-finite/);
  });

  it.each([8, 12, 20])("confirms a candidate by elapsed time at %i AI FPS", (fps) => {
    const smoother = new EmotionSmoother({ alpha: 1, switchConfirmationMs: 150 });
    expect(smoother.update(probabilities(4, 0.65), 0).emotion).toBeNull();
    let acceptedAt = 0;
    for (let index = 1; index <= 6; index += 1) {
      const timestamp = index * 1000 / fps;
      const decision = smoother.update(probabilities(4, 0.65), timestamp);
      if (timestamp < 150) expect(decision.emotion).toBeNull();
      if (decision.emotion !== null) { acceptedAt = timestamp; break; }
    }
    expect(acceptedAt).toBeGreaterThanOrEqual(150);
    expect(acceptedAt).toBeLessThan(150 + 1000 / fps + 1e-6);
  });

  it("applies equivalent EMA decay at 8, 12, and 20 AI FPS", () => {
    const values = [8, 12, 20].map((fps) => {
      const smoother = new EmotionSmoother();
      smoother.update(probabilities(5, 0.8), 0);
      let value = 0;
      for (let index = 1; index <= fps / 2; index += 1) {
        value = smoother.update(probabilities(4, 0.8), index * 1000 / fps).probabilities[4] ?? 0;
      }
      return value;
    });
    expect(values[0]).toBeCloseTo(values[1] ?? 0, 8);
    expect(values[1]).toBeCloseTo(values[2] ?? 0, 8);
  });

  it("cannot confirm by repeating the same timestamp and discards interrupted history", () => {
    const smoother = new EmotionSmoother({ alpha: 1 });
    for (let index = 0; index < 10; index += 1) {
      expect(smoother.update(probabilities(4, 0.65), 100).emotion).toBeNull();
    }
    expect(smoother.update(probabilities(4, 0.65), 200).emotion).toBe("happiness");
    expect(smoother.update(probabilities(4, 0.65), 1200).uncertaintyReason).toBe("switch-pending");
    expect(() => smoother.update(probabilities(4, 0.65), 1199)).toThrow(/monotonic/);
    expect(() => smoother.update(probabilities(4, 0.65), Number.NaN)).toThrow(/timestamp/);
  });
});
