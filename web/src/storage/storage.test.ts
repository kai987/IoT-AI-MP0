import { describe, expect, it } from "vitest";
import { HighScoreStorage } from "./HighScoreStorage";
import { DEFAULT_USER_SETTINGS, SettingsStorage } from "./SettingsStorage";
import type { StorageAdapter } from "./StorageAdapter";

class MemoryStorage implements StorageAdapter {
  public readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }
}

class ThrowingStorage implements StorageAdapter {
  public getItem(): string | null {
    throw new DOMException("Storage unavailable", "SecurityError");
  }

  public setItem(): void {
    throw new DOMException("Storage unavailable", "QuotaExceededError");
  }

  public removeItem(): void {
    throw new DOMException("Storage unavailable", "SecurityError");
  }
}

describe("HighScoreStorage", () => {
  it("starts at zero and never lowers the record", () => {
    const storage = new MemoryStorage();
    const scores = new HighScoreStorage(storage);
    expect(scores.load()).toBe(0);
    expect(scores.save(120.9)).toBe(120);
    expect(scores.save(80)).toBe(120);
    expect(scores.load()).toBe(120);
    expect(storage.values.has("emotion-runner.web.high-score")).toBe(true);
  });

  it("recovers from corrupt or unavailable storage", () => {
    const storage = new MemoryStorage();
    storage.values.set("emotion-runner.web.high-score", "not-json");
    expect(new HighScoreStorage(storage).load()).toBe(0);
    expect(new HighScoreStorage(null).save(42)).toBe(42);
  });
});

describe("SettingsStorage", () => {
  it("round-trips camera, mode, mute, and volume preferences", () => {
    const storage = new MemoryStorage();
    const settings = new SettingsStorage(storage);
    const saved = settings.save({
      masterVolume: 0.6,
      muted: true,
      cameraDeviceId: "camera-2",
      controlMode: "keyboard",
    });

    expect(saved.masterVolume).toBe(0.6);
    expect(settings.load()).toEqual(saved);
    expect(storage.values.has("emotion-runner.web.settings")).toBe(true);
  });

  it("clamps volume and falls back from malformed data", () => {
    const storage = new MemoryStorage();
    const settings = new SettingsStorage(storage);
    expect(
      settings.save({
        ...DEFAULT_USER_SETTINGS,
        masterVolume: 5,
      }).masterVolume,
    ).toBe(1);

    storage.values.set("emotion-runner.web.settings", "{}");
    expect(settings.load()).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("falls back safely when localStorage access throws", () => {
    const settings = new SettingsStorage(new ThrowingStorage());

    expect(settings.load()).toEqual(DEFAULT_USER_SETTINGS);
    expect(() =>
      settings.save({
        masterVolume: 0.4,
        muted: true,
        cameraDeviceId: "camera-private",
        controlMode: "camera",
      }),
    ).not.toThrow();
    expect(() => settings.clear()).not.toThrow();
  });
});
