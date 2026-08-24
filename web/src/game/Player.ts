import { DEFAULT_GAME_SETTINGS, type GameSettings } from "./Settings";
import { GameAction, type PlayerSnapshot, type Rect } from "./types";

export class Player {
  private readonly settings: GameSettings;

  public x = 0;
  public y = 0;
  public velocityY = 0;
  public onGround = true;
  public lives = 0;
  public runPhase = 0;
  public faceAction: GameAction | null = null;
  public faceActionUntil = 0;

  private boostUntil = 0;
  private attackUntil = 0;
  private shieldUntil = 0;
  private invulnerableUntil = 0;

  public constructor(settings: GameSettings = DEFAULT_GAME_SETTINGS) {
    this.settings = settings;
    this.reset();
  }

  public reset(): void {
    this.x = this.settings.player.startX;
    this.y = this.settings.player.groundY - this.settings.player.height;
    this.velocityY = 0;
    this.onGround = true;
    this.boostUntil = 0;
    this.attackUntil = 0;
    this.shieldUntil = 0;
    this.faceAction = null;
    this.faceActionUntil = 0;
    this.invulnerableUntil = 0;
    this.lives = this.settings.player.initialLives;
    this.runPhase = 0;
  }

  public get rect(): Rect {
    return {
      x: Math.round(this.x),
      y: Math.round(this.y),
      width: this.settings.player.width,
      height: this.settings.player.height,
    };
  }

  public get collisionRect(): Rect {
    const rect = this.rect;
    const insetX = this.settings.player.collisionInsetX;
    const insetY = this.settings.player.collisionInsetY;
    return {
      x: rect.x + insetX / 2,
      y: rect.y + insetY / 2,
      width: Math.max(0, rect.width - insetX),
      height: Math.max(0, rect.height - insetY),
    };
  }

  public jump(): boolean {
    if (!this.onGround) {
      return false;
    }
    this.velocityY = this.settings.player.jumpVelocity;
    this.onGround = false;
    return true;
  }

  public activateBoost(now: number): void {
    this.boostUntil = Math.max(
      this.boostUntil,
      now + this.settings.actions.boostDuration,
    );
  }

  public attack(now: number): void {
    this.attackUntil = Math.max(
      this.attackUntil,
      now + this.settings.actions.attackDuration,
    );
  }

  public activateShield(now: number): void {
    this.shieldUntil = Math.max(
      this.shieldUntil,
      now + this.settings.actions.shieldDuration,
    );
  }

  public isBoosting(now: number): boolean {
    const faceBoost =
      this.faceAction === GameAction.Boost && now < this.faceActionUntil;
    return faceBoost || now < this.boostUntil;
  }

  public isAttacking(now: number): boolean {
    const faceAttack =
      this.faceAction === GameAction.Attack && now < this.faceActionUntil;
    return faceAttack || now < this.attackUntil;
  }

  public hasShield(now: number): boolean {
    const faceShield =
      this.faceAction === GameAction.Shield && now < this.faceActionUntil;
    return faceShield || now < this.shieldUntil;
  }

  public isInvulnerable(now: number): boolean {
    return now < this.invulnerableUntil;
  }

  public startFaceAction(action: GameAction, now: number): boolean {
    if (this.faceAction !== null) {
      return false;
    }

    let duration: number;
    switch (action) {
      case GameAction.Jump:
        if (!this.jump()) {
          return false;
        }
        duration = 0;
        break;
      case GameAction.Boost:
        duration = this.settings.actions.boostDuration;
        break;
      case GameAction.Attack:
        duration = this.settings.actions.attackDuration;
        break;
      case GameAction.Shield:
        duration = this.settings.actions.shieldDuration;
        break;
    }

    this.faceAction = action;
    this.faceActionUntil = now + duration;
    return true;
  }

  public faceActionIsComplete(now: number): boolean {
    if (this.faceAction === null) {
      return true;
    }
    if (this.faceAction === GameAction.Jump) {
      return this.onGround;
    }
    return now >= this.faceActionUntil;
  }

  public finishFaceAction(): void {
    this.faceAction = null;
    this.faceActionUntil = 0;
  }

  public getAttackRect(now: number): Rect | null {
    if (!this.isAttacking(now)) {
      return null;
    }
    const rect = this.rect;
    return {
      x: rect.x + rect.width - 2,
      y: rect.y + this.settings.player.attackYOffset,
      width: this.settings.player.attackWidth,
      height: this.settings.player.attackHeight,
    };
  }

  public consumeShield(now: number): void {
    this.shieldUntil = now;
    if (this.faceAction === GameAction.Shield) {
      this.faceActionUntil = now;
    }
  }

  public takeDamage(now: number): boolean {
    if (this.isInvulnerable(now)) {
      return false;
    }
    this.lives = Math.max(0, this.lives - 1);
    this.invulnerableUntil = now + this.settings.player.invulnerabilityDuration;
    return true;
  }

  public update(deltaSeconds: number, now: number): void {
    const delta = Math.max(0, deltaSeconds);
    this.runPhase += delta * (this.isBoosting(now) ? 13 : 8);
    if (this.onGround) {
      return;
    }

    this.velocityY += this.settings.player.gravity * delta;
    this.y += this.velocityY * delta;
    const groundTop = this.settings.player.groundY - this.settings.player.height;
    if (this.y >= groundTop) {
      this.y = groundTop;
      this.velocityY = 0;
      this.onGround = true;
    }
  }

  public getSnapshot(now: number): PlayerSnapshot {
    return {
      x: this.x,
      y: this.y,
      velocityY: this.velocityY,
      onGround: this.onGround,
      rect: this.rect,
      collisionRect: this.collisionRect,
      attackRect: this.getAttackRect(now),
      lives: this.lives,
      runPhase: this.runPhase,
      faceAction: this.faceAction,
      faceActionUntil: this.faceActionUntil,
      boosting: this.isBoosting(now),
      attacking: this.isAttacking(now),
      shielded: this.hasShield(now),
      invulnerable: this.isInvulnerable(now),
    };
  }
}
