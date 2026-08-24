import { DEFAULT_GAME_SETTINGS, type GameSettings } from "./Settings";
import {
  GameAction,
  type ActionControllerSnapshot,
  type ActionDecision,
  type EmotionName,
  type EmotionSample,
} from "./types";

export const EMOTION_TO_ACTION: Readonly<Partial<Record<EmotionName, GameAction>>> = {
  surprise: GameAction.Boost,
  happiness: GameAction.Jump,
  anger: GameAction.Attack,
  sadness: GameAction.Shield,
};

export const ACTION_TO_EMOTION: Readonly<Record<GameAction, EmotionName>> = {
  [GameAction.Jump]: "happiness",
  [GameAction.Boost]: "surprise",
  [GameAction.Attack]: "anger",
  [GameAction.Shield]: "sadness",
};

export class ActionController {
  private readonly settings: GameSettings;
  private readonly nextReady: Record<GameAction, number>;

  private heldActionValue: GameAction | null = null;
  private heldEmotionValue: EmotionName | null = null;
  private uncertainSinceValue: number | null = null;
  private lastActionValue: GameAction | null = null;
  private lastSourceValue: "face" | "keyboard" | null = null;
  private statusMessageValue = "表情操作の準備完了";

  public constructor(settings: GameSettings = DEFAULT_GAME_SETTINGS) {
    this.settings = settings;
    this.nextReady = this.emptyCooldowns();
  }

  public reset(): void {
    this.heldActionValue = null;
    this.heldEmotionValue = null;
    this.uncertainSinceValue = null;
    this.lastActionValue = null;
    this.lastSourceValue = null;
    this.statusMessageValue = "表情操作の準備完了";
    for (const action of Object.values(GameAction)) {
      this.nextReady[action] = 0;
    }
  }

  public update(sample: EmotionSample, now: number): ActionDecision | null {
    if (sample.uncertain || sample.emotion === null) {
      this.handleUncertain(now, "判定不能：表情を保持してください");
      return null;
    }

    if (sample.emotion === "neutral") {
      this.uncertainSinceValue = null;
      this.clearHeldAction();
      this.statusMessageValue = "無表情：通常走行";
      return null;
    }

    const action = EMOTION_TO_ACTION[sample.emotion];
    if (action === undefined) {
      this.uncertainSinceValue = null;
      this.clearHeldAction();
      this.statusMessageValue = `${sample.emotion}：割り当て動作なし`;
      return null;
    }

    if (this.heldActionValue === action && this.heldEmotionValue === sample.emotion) {
      this.uncertainSinceValue = null;
      this.statusMessageValue = `${action.toUpperCase()} 継続中`;
      return null;
    }

    if (sample.confidence < this.settings.recognition.actionConfidenceThreshold) {
      this.handleUncertain(now, `確信度不足 ${Math.round(sample.confidence * 100)}%`);
      return null;
    }

    if (!this.featuresSupport(sample)) {
      this.handleUncertain(now, `${sample.emotion}：口・眉特徴の確認待ち`);
      return null;
    }

    this.heldActionValue = action;
    this.heldEmotionValue = sample.emotion;
    this.uncertainSinceValue = null;
    this.lastActionValue = action;
    this.lastSourceValue = "face";
    this.statusMessageValue = `${action.toUpperCase()} 継続開始`;
    return { action, source: "face", emotion: sample.emotion };
  }

  public requestKeyboard(action: GameAction, now: number): ActionDecision | null {
    const remaining = this.cooldownRemaining(action, now);
    if (remaining > 0) {
      this.statusMessageValue = `${action} クールダウン ${remaining.toFixed(1)}s`;
      return null;
    }

    this.nextReady[action] = now + this.cooldownFor(action);
    this.lastActionValue = action;
    this.lastSourceValue = "keyboard";
    this.statusMessageValue = `${action.toUpperCase()} 発動 (keyboard)`;
    return { action, source: "keyboard", emotion: null };
  }

  public cooldownRemaining(action: GameAction, now: number): number {
    return Math.max(0, this.nextReady[action] - now);
  }

  public get heldAction(): GameAction | null {
    return this.heldActionValue;
  }

  public get heldEmotion(): EmotionName | null {
    return this.heldEmotionValue;
  }

  public getSnapshot(): ActionControllerSnapshot {
    return {
      heldAction: this.heldActionValue,
      heldEmotion: this.heldEmotionValue,
      uncertainSince: this.uncertainSinceValue,
      lastAction: this.lastActionValue,
      lastSource: this.lastSourceValue,
      statusMessage: this.statusMessageValue,
    };
  }

  private handleUncertain(now: number, message: string): void {
    if (this.uncertainSinceValue === null) {
      this.uncertainSinceValue = now;
    }
    const elapsed = now - this.uncertainSinceValue;
    if (elapsed >= this.settings.actions.faceActionLossGrace) {
      this.clearHeldAction();
      this.statusMessageValue = message;
      return;
    }
    if (this.heldActionValue !== null) {
      const remaining = this.settings.actions.faceActionLossGrace - elapsed;
      this.statusMessageValue = `${message}（動作保持 ${remaining.toFixed(1)}s）`;
      return;
    }
    this.statusMessageValue = message;
  }

  private clearHeldAction(): void {
    this.heldActionValue = null;
    this.heldEmotionValue = null;
  }

  private featuresSupport(sample: EmotionSample): boolean {
    if (sample.emotion === "sadness") {
      return true;
    }
    const features = sample.features;
    if (features === null) {
      return sample.confidence >= this.settings.recognition.strongClassifierConfidence;
    }
    switch (sample.emotion) {
      case "surprise":
        return (
          features.mouthOpenRatio >=
            this.settings.recognition.surpriseMouthRatioThreshold ||
          features.jawOpen >= this.settings.recognition.surpriseJawOpenThreshold ||
          features.eyeWide >= this.settings.recognition.surpriseEyeWideThreshold ||
          features.browRaise >= this.settings.recognition.surpriseBrowRaiseThreshold ||
          sample.confidence >= this.settings.recognition.strongClassifierConfidence
        );
      case "happiness":
        return (
          features.smile >= this.settings.recognition.happinessSmileThreshold ||
          sample.confidence >= this.settings.recognition.strongClassifierConfidence
        );
      case "anger":
        return (
          features.browFurrow >=
            this.settings.recognition.angerBrowFurrowThreshold ||
          sample.confidence >= this.settings.recognition.strongClassifierConfidence
        );
      default:
        return true;
    }
  }

  private cooldownFor(action: GameAction): number {
    switch (action) {
      case GameAction.Jump:
        return this.settings.actions.jumpCooldown;
      case GameAction.Boost:
        return this.settings.actions.boostCooldown;
      case GameAction.Attack:
        return this.settings.actions.attackCooldown;
      case GameAction.Shield:
        return this.settings.actions.shieldCooldown;
    }
  }

  private emptyCooldowns(): Record<GameAction, number> {
    return {
      [GameAction.Jump]: 0,
      [GameAction.Boost]: 0,
      [GameAction.Attack]: 0,
      [GameAction.Shield]: 0,
    };
  }
}
