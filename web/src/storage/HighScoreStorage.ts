import { browserStorage, type StorageAdapter } from "./StorageAdapter";

const HIGH_SCORE_KEY = "emotion-runner.web.high-score";

interface StoredHighScore {
  readonly version: 1;
  readonly highScore: number;
}

export class HighScoreStorage {
  public constructor(
    private readonly storage: StorageAdapter | null = browserStorage(),
    private readonly key = HIGH_SCORE_KEY,
  ) {}

  public load(): number {
    if (this.storage === null) {
      return 0;
    }
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) {
        return 0;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredHighScore(parsed)) {
        return 0;
      }
      return sanitizeScore(parsed.highScore);
    } catch {
      return 0;
    }
  }

  /** Save only a new record so a stale tab cannot lower the persisted score. */
  public save(score: number): number {
    const highScore = Math.max(this.load(), sanitizeScore(score));
    if (this.storage === null) {
      return highScore;
    }
    const value: StoredHighScore = { version: 1, highScore };
    try {
      this.storage.setItem(this.key, JSON.stringify(value));
    } catch {
      // Private browsing and quota errors must not stop gameplay.
    }
    return highScore;
  }

  public clear(): void {
    try {
      this.storage?.removeItem(this.key);
    } catch {
      // Storage is an optional enhancement.
    }
  }
}

function sanitizeScore(score: number): number {
  return Number.isFinite(score) ? Math.max(0, Math.trunc(score)) : 0;
}

function isStoredHighScore(value: unknown): value is StoredHighScore {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && typeof candidate.highScore === "number";
}
