import { describe, expect, it } from "vitest";
import { LatencyTracker } from "./LatencyTracker";

describe("LatencyTracker", () => {
  it("reports nearest-rank percentiles of a bounded window", () => {
    const tracker = new LatencyTracker(4);
    for (const value of [1000, 10, 20, 30, 40]) tracker.observe(value);
    expect(tracker.observe(Number.NaN)).toEqual({ p50Ms: 20, p95Ms: 40, samples: 4 });
    tracker.reset();
    expect(tracker.observe(-1)).toEqual({ p50Ms: 0, p95Ms: 0, samples: 0 });
    expect(tracker.observe(0)).toEqual({ p50Ms: 0, p95Ms: 0, samples: 1 });
  });
  it("rejects unbounded or invalid window sizes", () => {
    expect(() => new LatencyTracker(0)).toThrow();
    expect(() => new LatencyTracker(2.5)).toThrow();
  });
});
