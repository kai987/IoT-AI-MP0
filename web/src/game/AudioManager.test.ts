import { describe, expect, it } from "vitest";
import { AudioManager, type AudioBackend } from "./AudioManager";
import type { MusicName, SoundEffectName } from "./types";

class FakeAudioBackend implements AudioBackend {
  public initialized = false;
  public music: MusicName | null = null;
  public musicVolume = 0;
  public readonly effects: Array<{ name: SoundEffectName; volume: number }> = [];

  public initialize(): Promise<void> {
    this.initialized = true;
    return Promise.resolve();
  }

  public playMusic(name: MusicName, volume: number): void {
    this.music = name;
    this.musicVolume = volume;
  }

  public stopMusic(): void {
    this.music = null;
  }

  public setMusicVolume(volume: number): void {
    this.musicVolume = volume;
  }

  public playEffect(name: SoundEffectName, volume: number): void {
    this.effects.push({ name, volume });
  }

  public shutdown(): void {
    this.music = null;
  }
}

describe("AudioManager", () => {
  it("defers browser audio until explicit initialization", async () => {
    const backend = new FakeAudioBackend();
    const audio = new AudioManager(backend);
    audio.playMusic("menu");
    expect(backend.initialized).toBe(false);

    expect(await audio.initialize()).toBe(true);
    expect(backend.music).toBe("menu");
    expect(audio.volumePercent).toBe(80);
  });

  it("clamps volume, mutes music, and restores sound on adjustment", async () => {
    const backend = new FakeAudioBackend();
    const audio = new AudioManager(backend);
    await audio.initialize();
    audio.playMusic("game");

    expect(audio.setVolume(3)).toBe(1);
    expect(audio.toggleMute()).toBe(true);
    expect(backend.musicVolume).toBe(0);
    expect(audio.adjustVolume(-0.1)).toBe(0.9);
    expect(audio.muted).toBe(false);
    expect(backend.musicVolume).toBeCloseTo(0.306);
  });

  it("uses the quieter BGM level while paused", async () => {
    const backend = new FakeAudioBackend();
    const audio = new AudioManager(backend);
    await audio.initialize();
    audio.playMusic("game");
    audio.setPaused(true);

    expect(backend.musicVolume).toBeCloseTo(0.096);
    expect(backend.effects.at(-1)?.name).toBe("pause");
  });
});
