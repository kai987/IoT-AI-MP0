import { DEFAULT_GAME_SETTINGS, type GameSettings } from "./Settings";
import {
  type CoinSnapshot,
  type ObstacleKind,
  type ObstacleSnapshot,
  type Rect,
} from "./types";

export interface ObstacleSpec {
  readonly width: number;
  readonly height: number;
  readonly destructible: boolean;
  readonly scoreValue: number;
}

export const OBSTACLE_SPECS: Readonly<Record<ObstacleKind, ObstacleSpec>> = {
  rock: { width: 54, height: 44, destructible: false, scoreValue: 100 },
  crate: { width: 62, height: 62, destructible: true, scoreValue: 150 },
  enemy: { width: 54, height: 80, destructible: true, scoreValue: 200 },
  barrier: { width: 48, height: 128, destructible: false, scoreValue: 180 },
};

/** A small reproducible PRNG; identical seeds produce identical spawn streams. */
export class SeededRandom {
  private state: number;

  public constructor(seed: number | string = Date.now()) {
    this.state = normalizeSeed(seed);
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  public uniform(minimum: number, maximum: number): number {
    return minimum + (maximum - minimum) * this.next();
  }

  public integer(minimum: number, maximum: number): number {
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || maximum < minimum) {
      throw new RangeError("integer() requires an ordered inclusive integer range");
    }
    return minimum + Math.floor(this.next() * (maximum - minimum + 1));
  }

  public choice<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new RangeError("choice() requires at least one value");
    }
    const value = values[Math.floor(this.next() * values.length)];
    if (value === undefined) {
      throw new RangeError("choice() selected an invalid index");
    }
    return value;
  }
}

export class Obstacle {
  public alive = true;
  public passed = false;
  public collided = false;

  public readonly id: number;
  public readonly kind: ObstacleKind;
  public readonly groundY: number;
  public readonly width: number;
  public readonly height: number;
  public readonly destructible: boolean;
  public readonly scoreValue: number;
  public x: number;

  public constructor(
    id: number,
    kind: ObstacleKind,
    x: number,
    settings: GameSettings = DEFAULT_GAME_SETTINGS,
  ) {
    const spec = OBSTACLE_SPECS[kind];
    this.id = id;
    this.kind = kind;
    this.x = x;
    this.groundY = settings.player.groundY;
    this.width = spec.width;
    this.height = spec.height;
    this.destructible = spec.destructible;
    this.scoreValue = spec.scoreValue;
  }

  public get rect(): Rect {
    return {
      x: Math.round(this.x),
      y: this.groundY - this.height,
      width: this.width,
      height: this.height,
    };
  }

  public update(deltaSeconds: number, speed: number): void {
    this.x -= speed * Math.max(0, deltaSeconds);
  }

  public isOffscreen(): boolean {
    return this.x + this.width < -20;
  }

  public getSnapshot(): ObstacleSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      x: this.x,
      groundY: this.groundY,
      width: this.width,
      height: this.height,
      rect: this.rect,
      destructible: this.destructible,
      scoreValue: this.scoreValue,
      alive: this.alive,
      passed: this.passed,
      collided: this.collided,
    };
  }
}

export class Coin {
  public alive = true;

  public constructor(
    public readonly id: number,
    public x: number,
    public readonly y: number,
    public readonly radius = 12,
  ) {}

  public get rect(): Rect {
    return {
      x: Math.round(this.x - this.radius),
      y: Math.round(this.y - this.radius),
      width: this.radius * 2,
      height: this.radius * 2,
    };
  }

  public update(deltaSeconds: number, speed: number): void {
    this.x -= speed * Math.max(0, deltaSeconds);
  }

  public isOffscreen(): boolean {
    return this.x + this.radius < -10;
  }

  public getSnapshot(): CoinSnapshot {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      radius: this.radius,
      rect: this.rect,
      alive: this.alive,
    };
  }
}

function normalizeSeed(seed: number | string): number {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) {
      throw new TypeError("The random seed must be finite");
    }
    return Math.trunc(seed) >>> 0;
  }

  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
