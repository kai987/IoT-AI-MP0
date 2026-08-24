import { DEFAULT_GAME_SETTINGS } from "../game/Settings";
import type { ControlMode } from "../game/types";
import { browserStorage, type StorageAdapter } from "./StorageAdapter";

const SETTINGS_KEY = "emotion-runner.web.settings";

export interface UserSettings {
  readonly masterVolume: number;
  readonly muted: boolean;
  readonly cameraDeviceId: string | null;
  readonly controlMode: ControlMode;
}

interface StoredSettings extends UserSettings {
  readonly version: 1;
}

export const DEFAULT_USER_SETTINGS: UserSettings = Object.freeze({
  masterVolume: DEFAULT_GAME_SETTINGS.audio.masterVolume,
  muted: false,
  cameraDeviceId: null,
  controlMode: "camera",
});

export class SettingsStorage {
  public constructor(
    private readonly storage: StorageAdapter | null = browserStorage(),
    private readonly key = SETTINGS_KEY,
  ) {}

  public load(): UserSettings {
    if (this.storage === null) {
      return { ...DEFAULT_USER_SETTINGS };
    }
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) {
        return { ...DEFAULT_USER_SETTINGS };
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredSettings(parsed)) {
        return { ...DEFAULT_USER_SETTINGS };
      }
      return normalizeSettings(parsed);
    } catch {
      return { ...DEFAULT_USER_SETTINGS };
    }
  }

  public save(settings: UserSettings): UserSettings {
    const normalized = normalizeSettings(settings);
    const stored: StoredSettings = { version: 1, ...normalized };
    try {
      this.storage?.setItem(this.key, JSON.stringify(stored));
    } catch {
      // Storage failure must never block menu controls.
    }
    return normalized;
  }

  public patch(changes: Partial<UserSettings>): UserSettings {
    return this.save({ ...this.load(), ...changes });
  }

  public clear(): void {
    try {
      this.storage?.removeItem(this.key);
    } catch {
      // Storage is optional.
    }
  }
}

function normalizeSettings(settings: UserSettings): UserSettings {
  const minimum = DEFAULT_GAME_SETTINGS.audio.minVolume;
  const maximum = DEFAULT_GAME_SETTINGS.audio.maxVolume;
  const masterVolume = Number.isFinite(settings.masterVolume)
    ? Math.max(minimum, Math.min(maximum, settings.masterVolume))
    : DEFAULT_USER_SETTINGS.masterVolume;
  return {
    masterVolume,
    muted: settings.muted === true,
    cameraDeviceId:
      typeof settings.cameraDeviceId === "string" && settings.cameraDeviceId.length > 0
        ? settings.cameraDeviceId
        : null,
    controlMode: settings.controlMode === "keyboard" ? "keyboard" : "camera",
  };
}

function isStoredSettings(value: unknown): value is StoredSettings {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.masterVolume === "number" &&
    typeof candidate.muted === "boolean" &&
    (candidate.cameraDeviceId === null || typeof candidate.cameraDeviceId === "string") &&
    (candidate.controlMode === "camera" || candidate.controlMode === "keyboard")
  );
}
