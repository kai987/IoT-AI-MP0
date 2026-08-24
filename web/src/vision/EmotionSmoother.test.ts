import { describe, expect, it } from "vitest";

import { EmotionSmoother } from "./EmotionSmoother";

function probabilities(topIndex: number, topValue: number): number[] {
  const remainder = (1 - topValue) / 7;
  return new Array<number>(8)
    .fill(remainder)
    .map((value, index) => (index === topIndex ? topValue : value));
}

describe("EmotionSmoother", () => {
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
});
