import { DEFAULT_GAME_SETTINGS, type GameSettings } from "./Settings";
import type { MusicName, SoundEffectName } from "./types";

export interface AudioBackend {
  initialize(): Promise<void>;
  playMusic(name: MusicName, volume: number): void;
  stopMusic(fadeSeconds: number): void;
  setMusicVolume(volume: number): void;
  playEffect(name: SoundEffectName, volume: number): void;
  shutdown(): void;
}

export interface GameAudio {
  playMusic(name: MusicName | null): void;
  play(name: SoundEffectName): void;
  setPaused(paused: boolean): void;
}

/**
 * Browser-safe audio state. AudioContext creation is intentionally deferred to
 * initialize(), which the UI must call from a click/key gesture.
 */
export class AudioManager implements GameAudio {
  private readonly settings: GameSettings;
  private readonly backend: AudioBackend;
  private enabledValue = false;
  private mutedValue = false;
  private pausedValue = false;
  private masterVolumeValue: number;
  private currentMusicValue: MusicName | null = null;
  private errorValue: string | null = null;

  public constructor(
    backend: AudioBackend = new WebAudioBackend(),
    settings: GameSettings = DEFAULT_GAME_SETTINGS,
  ) {
    this.backend = backend;
    this.settings = settings;
    this.masterVolumeValue = settings.audio.masterVolume;
  }

  public async initialize(): Promise<boolean> {
    if (this.enabledValue) {
      return true;
    }
    try {
      await this.backend.initialize();
      this.enabledValue = true;
      if (this.currentMusicValue !== null) {
        this.backend.playMusic(this.currentMusicValue, this.musicVolume());
      }
      return true;
    } catch (error: unknown) {
      this.errorValue = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  public playMusic(name: MusicName | null): void {
    if (name === this.currentMusicValue) {
      return;
    }
    this.currentMusicValue = name;
    if (!this.enabledValue) {
      return;
    }
    if (name === null) {
      this.backend.stopMusic(0.35);
      return;
    }
    this.backend.playMusic(name, this.musicVolume());
  }

  public play(name: SoundEffectName): void {
    if (!this.enabledValue || this.mutedValue) {
      return;
    }
    this.backend.playEffect(
      name,
      this.masterVolumeValue * this.settings.audio.effectsVolume,
    );
  }

  public setPaused(paused: boolean): void {
    if (paused === this.pausedValue) {
      this.applyMusicVolume();
      return;
    }
    this.pausedValue = paused;
    this.applyMusicVolume();
    this.play(paused ? "pause" : "resume");
  }

  public toggleMute(): boolean {
    this.mutedValue = !this.mutedValue;
    this.applyMusicVolume();
    return this.mutedValue;
  }

  public setMuted(muted: boolean): void {
    this.mutedValue = muted;
    this.applyMusicVolume();
  }

  public setVolume(volume: number): number {
    this.masterVolumeValue = clamp(
      volume,
      this.settings.audio.minVolume,
      this.settings.audio.maxVolume,
    );
    this.applyMusicVolume();
    return this.masterVolumeValue;
  }

  public adjustVolume(delta: number): number {
    this.mutedValue = false;
    return this.setVolume(this.masterVolumeValue + delta);
  }

  public shutdown(): void {
    this.backend.shutdown();
    this.enabledValue = false;
  }

  public get enabled(): boolean {
    return this.enabledValue;
  }

  public get muted(): boolean {
    return this.mutedValue;
  }

  public get paused(): boolean {
    return this.pausedValue;
  }

  public get masterVolume(): number {
    return this.masterVolumeValue;
  }

  public get volumePercent(): number {
    return Math.round(this.masterVolumeValue * 100);
  }

  public get currentMusic(): MusicName | null {
    return this.currentMusicValue;
  }

  public get error(): string | null {
    return this.errorValue;
  }

  private musicVolume(): number {
    if (this.mutedValue) {
      return 0;
    }
    const relative = this.pausedValue
      ? this.settings.audio.pausedMusicVolume
      : this.settings.audio.musicVolume;
    return relative * this.masterVolumeValue;
  }

  private applyMusicVolume(): void {
    if (this.enabledValue) {
      this.backend.setMusicVolume(this.musicVolume());
    }
  }
}

class WebAudioBackend implements AudioBackend {
  private context: AudioContext | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;
  private music = new Map<MusicName, AudioBuffer>();
  private effects = new Map<SoundEffectName, AudioBuffer>();

  public async initialize(): Promise<void> {
    if (this.context !== null) {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      return;
    }
    const AudioContextClass = audioContextConstructor();
    if (AudioContextClass === null) {
      throw new Error("Web Audio API is unavailable in this browser");
    }
    const context = new AudioContextClass({ latencyHint: "interactive" });
    this.context = context;
    const generated = generateAudio(context.sampleRate);
    for (const [name, samples] of generated.music) {
      this.music.set(name, makeBuffer(context, samples));
    }
    for (const [name, samples] of generated.effects) {
      this.effects.set(name, makeBuffer(context, samples));
    }
    if (context.state === "suspended") {
      await context.resume();
    }
  }

  public playMusic(name: MusicName, volume: number): void {
    const context = this.context;
    const buffer = this.music.get(name);
    if (context === null || buffer === undefined) {
      return;
    }
    this.stopMusic(0);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.value = clamp(volume, 0, 1);
    source.connect(gain).connect(context.destination);
    source.start();
    this.musicSource = source;
    this.musicGain = gain;
  }

  public stopMusic(fadeSeconds: number): void {
    const source = this.musicSource;
    const gain = this.musicGain;
    const context = this.context;
    this.musicSource = null;
    this.musicGain = null;
    if (source === null || gain === null || context === null) {
      return;
    }
    const duration = Math.max(0, fadeSeconds);
    if (duration > 0) {
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
      gain.gain.linearRampToValueAtTime(0, context.currentTime + duration);
    }
    source.stop(context.currentTime + duration);
  }

  public setMusicVolume(volume: number): void {
    if (this.musicGain !== null && this.context !== null) {
      this.musicGain.gain.setValueAtTime(
        clamp(volume, 0, 1),
        this.context.currentTime,
      );
    }
  }

  public playEffect(name: SoundEffectName, volume: number): void {
    const context = this.context;
    const buffer = this.effects.get(name);
    if (context === null || buffer === undefined) {
      return;
    }
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = clamp(volume, 0, 1);
    source.connect(gain).connect(context.destination);
    source.start();
  }

  public shutdown(): void {
    this.stopMusic(0);
    const context = this.context;
    this.context = null;
    this.music.clear();
    this.effects.clear();
    if (context !== null) {
      void context.close();
    }
  }
}

interface GeneratedAudio {
  readonly music: ReadonlyMap<MusicName, Float32Array>;
  readonly effects: ReadonlyMap<SoundEffectName, Float32Array>;
}

function generateAudio(sampleRate: number): GeneratedAudio {
  const random = seededNoise(20_260_717);
  const effects = new Map<SoundEffectName, Float32Array>([
    ["click", sequence(sampleRate, [[659.25, 0.045], [880, 0.065]], "square", 0.25)],
    ["start", sequence(sampleRate, [[523.25, 0.07], [659.25, 0.07], [783.99, 0.07], [1046.5, 0.16]], "triangle", 0.38)],
    ["score", sequence(sampleRate, [[880, 0.055], [1318.51, 0.12]], "triangle", 0.38)],
    ["jump", tone(sampleRate, 310, 0.19, 760, "sine", 0.55)],
    ["boost", mix(tone(sampleRate, 150, 0.38, 920, "saw", 0.34), tone(sampleRate, 300, 0.38, 1500, "sine", 0.25))],
    ["attack", mix(tone(sampleRate, 260, 0.22, 85, "saw", 0.42), noise(sampleRate, 0.16, 0.28, random))],
    ["shield", mix(sequence(sampleRate, [[523.25, 0.08], [783.99, 0.09], [1046.5, 0.18]], "sine", 0.34), tone(sampleRate, 420, 0.36, 880, "sine", 0.18))],
    ["destroy", mix(noise(sampleRate, 0.24, 0.48, random), tone(sampleRate, 180, 0.26, 55, "square", 0.25))],
    ["shield_block", mix(tone(sampleRate, 960, 0.17, 1450, "sine", 0.35), tone(sampleRate, 1280, 0.2, 850, "sine", 0.24))],
    ["hit", mix(noise(sampleRate, 0.2, 0.45, random), tone(sampleRate, 105, 0.24, 65, "sine", 0.38))],
    ["death", sequence(sampleRate, [[440, 0.16], [349.23, 0.16], [261.63, 0.2], [130.81, 0.42]], "triangle", 0.44)],
    ["pause", sequence(sampleRate, [[659.25, 0.09], [440, 0.14]], "triangle", 0.28)],
    ["resume", sequence(sampleRate, [[440, 0.09], [659.25, 0.14]], "triangle", 0.28)],
    ["error", sequence(sampleRate, [[180, 0.09], [150, 0.14]], "square", 0.24)],
  ]);
  return {
    music: new Map<MusicName, Float32Array>([
      ["menu", musicLoop(sampleRate, false, random)],
      ["game", musicLoop(sampleRate, true, random)],
    ]),
    effects,
  };
}

function musicLoop(
  sampleRate: number,
  energetic: boolean,
  random: () => number,
): Float32Array {
  const beat = energetic ? 0.2 : 0.25;
  const notes = energetic
    ? [523.25, 659.25, 783.99, 659.25, 587.33, 698.46, 880, 698.46]
    : [261.63, 329.63, 392, 329.63, 220, 261.63, 329.63, 392];
  const steps = energetic ? 32 : 32;
  const result = new Float32Array(Math.round(sampleRate * beat * steps));
  for (let index = 0; index < steps; index += 1) {
    const note = notes[index % notes.length];
    if (note === undefined) {
      continue;
    }
    overlay(
      result,
      tone(
        sampleRate,
        note,
        beat * 0.78,
        note,
        energetic ? "square" : "triangle",
        energetic ? 0.075 : 0.11,
      ),
      Math.round(index * beat * sampleRate),
    );
    if (energetic && index % 2 === 0) {
      overlay(result, noise(sampleRate, 0.035, 0.045, random), Math.round((index * beat + beat * 0.5) * sampleRate));
    }
  }
  normalize(result, 0.92);
  return result;
}

type Wave = "sine" | "square" | "triangle" | "saw";

function tone(
  sampleRate: number,
  startFrequency: number,
  duration: number,
  endFrequency: number,
  wave: Wave,
  volume: number,
): Float32Array {
  const length = Math.max(1, Math.round(sampleRate * duration));
  const result = new Float32Array(length);
  let phase = 0;
  const attack = Math.min(length, Math.round(sampleRate * 0.006));
  const release = Math.min(length - attack, Math.round(sampleRate * 0.04));
  for (let index = 0; index < length; index += 1) {
    const ratio = length <= 1 ? 0 : index / (length - 1);
    const frequency = startFrequency + (endFrequency - startFrequency) * ratio;
    phase += (2 * Math.PI * frequency) / sampleRate;
    const sine = Math.sin(phase);
    let value: number;
    switch (wave) {
      case "square":
        value = sine < 0 ? -1 : 1;
        break;
      case "triangle":
        value = (2 / Math.PI) * Math.asin(sine);
        break;
      case "saw":
        value = 2 * ((phase / (2 * Math.PI)) % 1) - 1;
        break;
      case "sine":
        value = sine;
        break;
    }
    const attackGain = attack > 0 && index < attack ? index / attack : 1;
    const releaseGain =
      release > 0 && index >= length - release ? (length - 1 - index) / release : 1;
    result[index] = value * Math.max(0, Math.min(attackGain, releaseGain)) * volume;
  }
  return result;
}

function sequence(
  sampleRate: number,
  notes: readonly (readonly [frequency: number, duration: number])[],
  wave: Wave,
  volume: number,
): Float32Array {
  const pieces = notes.map(([frequency, duration]) =>
    tone(sampleRate, frequency, duration, frequency, wave, volume),
  );
  const result = new Float32Array(pieces.reduce((total, piece) => total + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    result.set(piece, offset);
    offset += piece.length;
  }
  return result;
}

function noise(
  sampleRate: number,
  duration: number,
  volume: number,
  random: () => number,
): Float32Array {
  const length = Math.max(1, Math.round(sampleRate * duration));
  const result = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const release = 1 - index / length;
    result[index] = (random() * 2 - 1) * release * volume;
  }
  return result;
}

function mix(...signals: readonly Float32Array[]): Float32Array {
  const length = Math.max(...signals.map((signal) => signal.length));
  const result = new Float32Array(length);
  for (const signal of signals) {
    for (let index = 0; index < signal.length; index += 1) {
      result[index] = (result[index] ?? 0) + (signal[index] ?? 0);
    }
  }
  normalize(result, 0.95);
  return result;
}

function overlay(target: Float32Array, source: Float32Array, offset: number): void {
  const length = Math.min(source.length, target.length - offset);
  for (let index = 0; index < length; index += 1) {
    const targetIndex = offset + index;
    target[targetIndex] = (target[targetIndex] ?? 0) + (source[index] ?? 0);
  }
}

function normalize(samples: Float32Array, maximum: number): void {
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak > maximum) {
    const scale = maximum / peak;
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = (samples[index] ?? 0) * scale;
    }
  }
}

function makeBuffer(context: AudioContext, mono: Float32Array): AudioBuffer {
  const buffer = context.createBuffer(2, mono.length, context.sampleRate);
  buffer.getChannelData(0).set(mono);
  buffer.getChannelData(1).set(mono);
  return buffer;
}

function seededNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function audioContextConstructor():
  | (new (options?: AudioContextOptions) => AudioContext)
  | null {
  const root = globalThis as typeof globalThis & {
    webkitAudioContext?: new (options?: AudioContextOptions) => AudioContext;
  };
  return globalThis.AudioContext ?? root.webkitAudioContext ?? null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.min(maximum, value));
}
