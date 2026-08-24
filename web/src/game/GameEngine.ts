import { ActionController, ACTION_TO_EMOTION } from "./ActionController";
import { AudioManager, type GameAudio } from "./AudioManager";
import { Coin, Obstacle, SeededRandom } from "./Entities";
import { Player } from "./Player";
import { ACTION_PRESENTATION, DEFAULT_GAME_SETTINGS, type GameSettings } from "./Settings";
import {
  GameAction,
  GameState,
  UNCERTAIN_EMOTION_SAMPLE,
  rectsOverlap,
  type ActionDecision,
  type ActionSource,
  type ControlMode,
  type EmotionSample,
  type GameEvent,
  type GameSnapshot,
  type ObstacleKind,
  type SoundEffectName,
} from "./types";
import { HighScoreStorage } from "../storage/HighScoreStorage";

export interface GameEngineOptions {
  readonly settings?: GameSettings;
  readonly seed?: number | string;
  readonly audio?: GameAudio;
  readonly highScoreStorage?: HighScoreStorage;
  readonly mode?: ControlMode;
}

/** Headless, deterministic game simulation. All time values are seconds. */
export class GameEngine {
  public readonly player: Player;
  public readonly controller: ActionController;

  private readonly settings: GameSettings;
  private readonly random: SeededRandom;
  private readonly audio: GameAudio;
  private readonly highScoreStorage: HighScoreStorage;
  private readonly events: GameEvent[] = [];

  private stateValue = GameState.Menu;
  private modeValue: ControlMode;
  private obstaclesValue: Obstacle[] = [];
  private coinsValue: Coin[] = [];
  private latestEmotionSample: EmotionSample = UNCERTAIN_EMOTION_SAMPLE;
  private scoreValue = 0;
  private comboValue = 0;
  private bestComboValue = 0;
  private elapsedValue = 0;
  private distanceValue = 0;
  private currentSpeedValue: number;
  private nextObstacleAt: number;
  private nextCoinAt: number;
  private highScoreValue: number;
  private actionTipText = "";
  private actionTipUntil = 0;
  private nowValue = 0;
  private nextEntityId = 1;

  public constructor(options: GameEngineOptions = {}) {
    this.settings = options.settings ?? DEFAULT_GAME_SETTINGS;
    this.random = new SeededRandom(options.seed);
    this.audio = options.audio ?? new AudioManager(undefined, this.settings);
    this.highScoreStorage = options.highScoreStorage ?? new HighScoreStorage();
    this.modeValue = options.mode ?? "camera";
    this.player = new Player(this.settings);
    this.controller = new ActionController(this.settings);
    this.currentSpeedValue = this.settings.speed.baseScroll;
    this.nextObstacleAt = this.settings.spawning.initialObstacleTime;
    this.nextCoinAt = this.settings.spawning.initialCoinTime;
    this.highScoreValue = this.highScoreStorage.load();
    this.audio.playMusic("menu");
  }

  public get state(): GameState {
    return this.stateValue;
  }

  public get mode(): ControlMode {
    return this.modeValue;
  }

  public setMode(mode: ControlMode, now = this.nowValue): void {
    this.modeValue = mode;
    if (mode === "keyboard") {
      this.latestEmotionSample = {
        emotion: "neutral",
        confidence: 1,
        features: null,
        uncertain: false,
      };
      this.controller.update(this.latestEmotionSample, now);
    }
  }

  public start(now = this.nowValue): void {
    this.nowValue = finiteTime(now);
    this.player.reset();
    this.controller.reset();
    this.obstaclesValue = [];
    this.coinsValue = [];
    this.scoreValue = 0;
    this.comboValue = 0;
    this.bestComboValue = 0;
    this.elapsedValue = 0;
    this.distanceValue = 0;
    this.currentSpeedValue = this.settings.speed.baseScroll;
    this.nextObstacleAt = this.settings.spawning.initialObstacleTime;
    this.nextCoinAt = this.settings.spawning.initialCoinTime;
    this.nextEntityId = 1;
    this.flash("スタート！", this.nowValue, this.settings.layout.actionTipStartDuration);
    this.stateValue = GameState.Playing;
    this.audio.setPaused(false);
    this.audio.playMusic("game");
    this.audio.play("start");
  }

  public restart(now = this.nowValue): void {
    this.start(now);
  }

  public togglePause(): GameState {
    if (this.stateValue === GameState.Playing) {
      this.stateValue = GameState.Paused;
      this.audio.setPaused(true);
    } else if (this.stateValue === GameState.Paused) {
      this.stateValue = GameState.Playing;
      this.audio.setPaused(false);
    }
    return this.stateValue;
  }

  public pauseToggle(): GameState {
    return this.togglePause();
  }

  public returnToMenu(): void {
    this.stateValue = GameState.Menu;
    this.audio.setPaused(false);
    this.audio.playMusic("menu");
  }

  public updateEmotion(
    sample: EmotionSample,
    now = this.nowValue,
  ): ActionDecision | null {
    this.latestEmotionSample = sample;
    if (this.stateValue !== GameState.Playing || this.modeValue !== "camera") {
      return null;
    }
    const timestamp = finiteTime(now);
    this.nowValue = Math.max(this.nowValue, timestamp);
    const decision = this.controller.update(sample, timestamp);
    this.advanceFaceAction(timestamp);
    return decision;
  }

  public setEmotionSample(sample: EmotionSample, now = this.nowValue): ActionDecision | null {
    return this.updateEmotion(sample, now);
  }

  public requestAction(
    action: GameAction,
    source: ActionSource = "keyboard",
    now = this.nowValue,
  ): ActionDecision | null {
    if (this.stateValue !== GameState.Playing) {
      return null;
    }
    const timestamp = finiteTime(now);
    this.nowValue = Math.max(this.nowValue, timestamp);
    if (source === "face") {
      const decision = this.updateEmotion(
        {
          emotion: ACTION_TO_EMOTION[action],
          confidence: 1,
          features: null,
          uncertain: false,
        },
        timestamp,
      );
      return decision;
    }

    const decision = this.controller.requestKeyboard(action, timestamp);
    this.applyKeyboardDecision(decision, timestamp);
    return decision;
  }

  public update(deltaSeconds: number, now: number): void {
    const timestamp = finiteTime(now);
    this.nowValue = Math.max(this.nowValue, timestamp);
    if (this.stateValue !== GameState.Playing) {
      return;
    }

    const delta = Math.min(
      this.settings.window.maxDeltaSeconds,
      Math.max(0, Number.isFinite(deltaSeconds) ? deltaSeconds : 0),
    );
    this.elapsedValue += delta;

    if (this.modeValue === "camera") {
      this.controller.update(this.latestEmotionSample, timestamp);
      this.advanceFaceAction(timestamp);
    }

    const baseSpeed = Math.min(
      this.settings.speed.maxScroll,
      this.settings.speed.baseScroll +
        this.elapsedValue * this.settings.speed.increasePerSecond,
    );
    const multiplier = this.player.isBoosting(timestamp)
      ? this.settings.speed.boostMultiplier
      : 1;
    this.currentSpeedValue = baseSpeed * multiplier;
    this.distanceValue += this.currentSpeedValue * delta;
    this.scoreValue +=
      this.currentSpeedValue * delta * this.settings.scoring.distanceMultiplier;

    this.player.update(delta, timestamp);
    this.advanceFaceAction(timestamp);

    if (this.elapsedValue >= this.nextObstacleAt) {
      this.spawnScheduledObstacle();
    }
    if (this.elapsedValue >= this.nextCoinAt) {
      this.spawnCoinGroup();
    }

    for (const obstacle of this.obstaclesValue) {
      obstacle.update(delta, this.currentSpeedValue);
    }
    for (const coin of this.coinsValue) {
      coin.update(delta, this.currentSpeedValue);
    }

    this.resolveAttacks(timestamp);
    this.resolvePlayerCollisions(timestamp);
    this.resolveCoinCollisions(timestamp);
    this.resolvePassedObstacles();
    this.advanceFaceAction(timestamp);

    this.obstaclesValue = this.obstaclesValue.filter(
      (obstacle) => obstacle.alive && !obstacle.isOffscreen(),
    );
    this.coinsValue = this.coinsValue.filter(
      (coin) => coin.alive && !coin.isOffscreen(),
    );

    if (this.player.lives <= 0) {
      this.finishGame();
    }
  }

  public getSnapshot(now = this.nowValue): GameSnapshot {
    const timestamp = finiteTime(now);
    return {
      state: this.stateValue,
      mode: this.modeValue,
      player: this.player.getSnapshot(timestamp),
      obstacles: this.obstaclesValue.map((obstacle) => obstacle.getSnapshot()),
      coins: this.coinsValue.map((coin) => coin.getSnapshot()),
      score: this.scoreValue,
      highScore: this.highScoreValue,
      combo: this.comboValue,
      bestCombo: this.bestComboValue,
      lives: this.player.lives,
      speed: this.currentSpeedValue,
      elapsed: this.elapsedValue,
      distance: this.distanceValue,
      actionTip:
        timestamp < this.actionTipUntil
          ? { text: this.actionTipText, expiresAt: this.actionTipUntil }
          : null,
      cooldowns: {
        [GameAction.Jump]: this.controller.cooldownRemaining(GameAction.Jump, timestamp),
        [GameAction.Boost]: this.controller.cooldownRemaining(GameAction.Boost, timestamp),
        [GameAction.Attack]: this.controller.cooldownRemaining(GameAction.Attack, timestamp),
        [GameAction.Shield]: this.controller.cooldownRemaining(GameAction.Shield, timestamp),
      },
      controller: this.controller.getSnapshot(),
    };
  }

  public drainEvents(): readonly GameEvent[] {
    const drained = this.events.splice(0, this.events.length);
    return drained;
  }

  /** Test and level-editor hook; scheduled spawning uses the same entity path. */
  public spawnObstacle(
    kind: ObstacleKind,
    x = this.settings.window.width + 35,
  ): void {
    this.obstaclesValue.push(
      new Obstacle(this.allocateEntityId(), kind, x, this.settings),
    );
  }

  /** Test and level-editor hook. */
  public spawnCoin(x: number, y: number): void {
    this.coinsValue.push(new Coin(this.allocateEntityId(), x, y));
  }

  private applyKeyboardDecision(decision: ActionDecision | null, now: number): void {
    if (decision === null) {
      return;
    }
    let succeeded = true;
    switch (decision.action) {
      case GameAction.Jump:
        succeeded = this.player.jump();
        break;
      case GameAction.Boost:
        this.player.activateBoost(now);
        break;
      case GameAction.Attack:
        this.player.attack(now);
        break;
      case GameAction.Shield:
        this.player.activateShield(now);
        break;
    }

    if (succeeded) {
      this.audio.play(actionSound(decision.action));
      const label = ACTION_PRESENTATION[decision.action].labelJa;
      this.flash(`${label}  [キーボード]`, now);
      this.events.push({ type: "action", action: decision.action, source: "keyboard" });
    } else {
      this.audio.play("error");
      this.flash("空中では再ジャンプできません", now);
    }
  }

  private advanceFaceAction(now: number): void {
    const current = this.player.faceAction;
    if (current !== null) {
      if (!this.player.faceActionIsComplete(now)) {
        return;
      }
      this.player.finishFaceAction();
    }

    if (!this.player.onGround) {
      return;
    }
    const desired = this.controller.heldAction;
    if (desired === null || !this.player.startFaceAction(desired, now)) {
      return;
    }

    this.audio.play(actionSound(desired));
    this.flash(`${ACTION_PRESENTATION[desired].labelJa}［表情］`, now);
    this.events.push({ type: "action", action: desired, source: "face" });
  }

  private spawnScheduledObstacle(): void {
    let choices: readonly ObstacleKind[];
    if (this.elapsedValue < this.settings.spawning.enemySpawnTime) {
      choices = ["rock", "rock", "rock"];
    } else if (this.elapsedValue < this.settings.spawning.barrierSpawnTime) {
      choices = ["rock", "crate", "crate", "enemy"];
    } else {
      choices = ["rock", "crate", "enemy", "barrier"];
    }
    this.spawnObstacle(this.random.choice(choices));
    const difficulty = Math.min(
      this.settings.spawning.maximumDifficultyIntervalReduction,
      this.elapsedValue / this.settings.spawning.difficultyRampSeconds,
    );
    const interval = this.random.uniform(
      this.settings.spawning.obstacleMinInterval,
      this.settings.spawning.obstacleMaxInterval,
    );
    this.nextObstacleAt =
      this.elapsedValue +
      Math.max(this.settings.spawning.minimumObstacleInterval, interval - difficulty);
  }

  private spawnCoinGroup(): void {
    const count = this.random.integer(
      this.settings.spawning.coinGroupMin,
      this.settings.spawning.coinGroupMax,
    );
    const high = this.random.next() < this.settings.spawning.highCoinProbability;
    const baseY =
      this.settings.player.groundY -
      (high
        ? this.settings.spawning.highCoinHeight
        : this.settings.spawning.lowCoinHeight);
    const startX = this.settings.window.width + 30;
    for (let index = 0; index < count; index += 1) {
      const arc =
        -this.settings.spawning.coinArcHeight *
        Math.sin((Math.PI * index) / Math.max(1, count - 1));
      this.spawnCoin(
        startX + index * this.settings.spawning.coinSpacing,
        baseY + arc,
      );
    }
    this.nextCoinAt =
      this.elapsedValue +
      this.random.uniform(
        this.settings.spawning.coinMinInterval,
        this.settings.spawning.coinMaxInterval,
      );
  }

  private resolveAttacks(now: number): void {
    const attackRect = this.player.getAttackRect(now);
    if (attackRect === null) {
      return;
    }
    for (const obstacle of this.obstaclesValue) {
      if (
        obstacle.alive &&
        obstacle.destructible &&
        rectsOverlap(attackRect, obstacle.rect)
      ) {
        obstacle.alive = false;
        this.reward(obstacle.scoreValue, true, null);
        this.audio.play("destroy");
        this.flash(`破壊 +${obstacle.scoreValue}`, now);
      }
    }
  }

  private resolvePlayerCollisions(now: number): void {
    const playerRect = this.player.collisionRect;
    for (const obstacle of this.obstaclesValue) {
      if (!obstacle.alive || !rectsOverlap(playerRect, obstacle.rect)) {
        continue;
      }
      obstacle.alive = false;
      obstacle.collided = true;
      if (this.player.hasShield(now)) {
        this.player.consumeShield(now);
        this.reward(this.settings.scoring.shieldBlockValue, true, null);
        this.audio.play("shield_block");
        this.flash(`シールド防御 +${this.settings.scoring.shieldBlockValue}`, now);
        this.events.push({ type: "shield-block" });
      } else if (this.player.takeDamage(now)) {
        this.comboValue = 0;
        if (this.player.lives > 0) {
          this.audio.play("hit");
        }
        this.flash("ダメージ！ ライフ -1", now);
        this.events.push({ type: "damage", lives: this.player.lives });
      }
    }
  }

  private resolveCoinCollisions(now: number): void {
    const playerRect = this.player.collisionRect;
    for (const coin of this.coinsValue) {
      if (coin.alive && rectsOverlap(playerRect, coin.rect)) {
        coin.alive = false;
        const value = this.player.isBoosting(now)
          ? this.settings.scoring.boostedCoinValue
          : this.settings.scoring.coinValue;
        this.reward(value, false, "score");
      }
    }
  }

  private resolvePassedObstacles(): void {
    const playerLeft = this.player.rect.x;
    for (const obstacle of this.obstaclesValue) {
      if (
        obstacle.alive &&
        !obstacle.passed &&
        obstacle.rect.x + obstacle.rect.width < playerLeft
      ) {
        obstacle.passed = true;
        this.reward(this.settings.scoring.passedObstacleValue, true, "score");
      }
    }
  }

  private reward(
    basePoints: number,
    increaseCombo = true,
    sound: SoundEffectName | null = "score",
  ): void {
    if (increaseCombo) {
      this.comboValue += 1;
      this.bestComboValue = Math.max(this.bestComboValue, this.comboValue);
    }
    const multiplier =
      1 +
      Math.min(this.comboValue, this.settings.scoring.maximumComboSteps) *
        this.settings.scoring.comboStep;
    const awarded = basePoints * multiplier;
    this.scoreValue += awarded;
    if (sound !== null) {
      this.audio.play(sound);
    }
    this.events.push({ type: "score", points: awarded });
  }

  private finishGame(): void {
    if (this.stateValue === GameState.GameOver) {
      return;
    }
    this.stateValue = GameState.GameOver;
    this.audio.playMusic(null);
    this.audio.play("death");
    this.highScoreValue = this.highScoreStorage.save(
      Math.max(this.highScoreValue, Math.trunc(this.scoreValue)),
    );
    this.events.push({
      type: "game-over",
      score: this.scoreValue,
      highScore: this.highScoreValue,
    });
  }

  private flash(
    message: string,
    now: number,
    duration = this.settings.layout.actionTipDuration,
  ): void {
    this.actionTipText = message;
    this.actionTipUntil = now + duration;
  }

  private allocateEntityId(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }
}

export function formatElapsedTime(seconds: number): string {
  const rounded = Math.round(Math.max(0, seconds) * 100) / 100;
  if (rounded < 60) {
    return `${rounded.toFixed(2).padStart(5, "0")}秒`;
  }
  const wholeSeconds = Math.trunc(rounded);
  const minutes = Math.trunc(wholeSeconds / 60);
  const remaining = String(wholeSeconds % 60).padStart(2, "0");
  return `${minutes}分${remaining}秒`;
}

function actionSound(action: GameAction): SoundEffectName {
  switch (action) {
    case GameAction.Jump:
      return "jump";
    case GameAction.Boost:
      return "boost";
    case GameAction.Attack:
      return "attack";
    case GameAction.Shield:
      return "shield";
  }
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
