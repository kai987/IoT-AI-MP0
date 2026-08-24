export enum GameAction {
  Jump = "jump",
  Boost = "boost",
  Attack = "attack",
  Shield = "shield",
}

export enum GameState {
  Menu = "menu",
  Playing = "playing",
  Paused = "paused",
  GameOver = "game_over",
}

export type ControlMode = "camera" | "keyboard";
export type ActionSource = "face" | "keyboard";

export type EmotionName =
  | "anger"
  | "contempt"
  | "disgust"
  | "fear"
  | "happiness"
  | "neutral"
  | "sadness"
  | "surprise";

export interface FacialFeatures {
  readonly mouthOpenRatio: number;
  readonly jawOpen: number;
  readonly browRaise: number;
  readonly browFurrow: number;
  readonly smile: number;
  readonly eyeWide: number;
}

export interface EmotionSample {
  readonly emotion: EmotionName | null;
  readonly confidence: number;
  readonly features: FacialFeatures | null;
  readonly uncertain: boolean;
}

export const UNCERTAIN_EMOTION_SAMPLE: EmotionSample = Object.freeze({
  emotion: null,
  confidence: 0,
  features: null,
  uncertain: true,
});

export interface ActionDecision {
  readonly action: GameAction;
  readonly source: ActionSource;
  readonly emotion: EmotionName | null;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ObstacleKind = "rock" | "crate" | "enemy" | "barrier";

export interface PlayerSnapshot {
  readonly x: number;
  readonly y: number;
  readonly velocityY: number;
  readonly onGround: boolean;
  readonly rect: Rect;
  readonly collisionRect: Rect;
  readonly attackRect: Rect | null;
  readonly lives: number;
  readonly runPhase: number;
  readonly faceAction: GameAction | null;
  readonly faceActionUntil: number;
  readonly boosting: boolean;
  readonly attacking: boolean;
  readonly shielded: boolean;
  readonly invulnerable: boolean;
}

export interface ObstacleSnapshot {
  readonly id: number;
  readonly kind: ObstacleKind;
  readonly x: number;
  readonly groundY: number;
  readonly width: number;
  readonly height: number;
  readonly rect: Rect;
  readonly destructible: boolean;
  readonly scoreValue: number;
  readonly alive: boolean;
  readonly passed: boolean;
  readonly collided: boolean;
}

export interface CoinSnapshot {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly rect: Rect;
  readonly alive: boolean;
}

export interface ActionTipSnapshot {
  readonly text: string;
  readonly expiresAt: number;
}

export interface ActionControllerSnapshot {
  readonly heldAction: GameAction | null;
  readonly heldEmotion: EmotionName | null;
  readonly uncertainSince: number | null;
  readonly lastAction: GameAction | null;
  readonly lastSource: ActionSource | null;
  readonly statusMessage: string;
}

export interface GameSnapshot {
  readonly state: GameState;
  readonly mode: ControlMode;
  readonly player: PlayerSnapshot;
  readonly obstacles: readonly ObstacleSnapshot[];
  readonly coins: readonly CoinSnapshot[];
  readonly score: number;
  readonly highScore: number;
  readonly combo: number;
  readonly bestCombo: number;
  readonly lives: number;
  readonly speed: number;
  readonly elapsed: number;
  readonly distance: number;
  readonly actionTip: ActionTipSnapshot | null;
  readonly cooldowns: Readonly<Record<GameAction, number>>;
  readonly controller: ActionControllerSnapshot;
}

export type MusicName = "menu" | "game";

export type SoundEffectName =
  | "click"
  | "start"
  | "score"
  | "jump"
  | "boost"
  | "attack"
  | "shield"
  | "destroy"
  | "shield_block"
  | "hit"
  | "death"
  | "pause"
  | "resume"
  | "error";

export type GameEvent =
  | { readonly type: "action"; readonly action: GameAction; readonly source: ActionSource }
  | { readonly type: "score"; readonly points: number }
  | { readonly type: "damage"; readonly lives: number }
  | { readonly type: "shield-block" }
  | { readonly type: "game-over"; readonly score: number; readonly highScore: number };

export function rectsOverlap(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}
