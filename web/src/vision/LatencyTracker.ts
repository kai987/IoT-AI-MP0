import { VISION_STABILITY } from "../RuntimeSettings";

/** 有限の遅延履歴 / 仅保留有限数量的延迟样本，不记录图像或人脸数据。 */
export class LatencyTracker {
  private readonly samples: number[] = [];

  public constructor(private readonly capacity: number = VISION_STABILITY.latencyWindowSize) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("Latency window must be positive");
  }

  public reset(): void { this.samples.length = 0; }

  public observe(latencyMs: number): { p50Ms: number; p95Ms: number; samples: number } {
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      this.samples.push(latencyMs);
      if (this.samples.length > this.capacity) this.samples.shift();
    }
    const sorted = [...this.samples].sort((left, right) => left - right);
    const percentile = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
    return { p50Ms: percentile(0.5), p95Ms: percentile(0.95), samples: sorted.length };
  }
}
