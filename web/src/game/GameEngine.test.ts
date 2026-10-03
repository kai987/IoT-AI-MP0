import { describe, expect, it } from "vitest";
import type { GameAudio } from "./AudioManager";
import { GameEngine, formatElapsedTime } from "./GameEngine";
import { DEFAULT_GAME_SETTINGS, type GameSettings } from "./Settings";
import {
  GameAction,
  GameState,
  type EmotionName,
  type EmotionSample,
  type MusicName,
  type SoundEffectName,
} from "./types";
import { HighScoreStorage } from "../storage/HighScoreStorage";
import type { StorageAdapter } from "../storage/StorageAdapter";

class MemoryStorage implements StorageAdapter {
  private readonly values = new Map<string, string>();

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

class FakeAudio implements GameAudio {
  public music: MusicName | null = null;
  public paused = false;
  public readonly sounds: SoundEffectName[] = [];

  public playMusic(name: MusicName | null): void {
    this.music = name;
  }

  public play(name: SoundEffectName): void {
    this.sounds.push(name);
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
  }
}

const TEST_SETTINGS: GameSettings = {
  ...DEFAULT_GAME_SETTINGS,
  spawning: {
    ...DEFAULT_GAME_SETTINGS.spawning,
    initialObstacleTime: 999,
    initialCoinTime: 999,
  },
};

function emotion(name: EmotionName): EmotionSample {
  return {
    emotion: name,
    confidence: 0.9,
    features: null,
    uncertain: false,
  };
}

function createEngine(seed: number | string = 7): {
  engine: GameEngine;
  audio: FakeAudio;
  storage: MemoryStorage;
} {
  const audio = new FakeAudio();
  const storage = new MemoryStorage();
  const engine = new GameEngine({
    settings: TEST_SETTINGS,
    seed,
    audio,
    highScoreStorage: new HighScoreStorage(storage),
  });
  return { engine, audio, storage };
}

describe("GameEngine", () => {
  it("provides menu/start/pause/restart state transitions and five lives", () => {
    const { engine, audio } = createEngine();
    expect(engine.state).toBe(GameState.Menu);
    expect(audio.music).toBe("menu");

    engine.start(1);
    expect(engine.state).toBe(GameState.Playing);
    expect(engine.getSnapshot(1).lives).toBe(5);
    expect(engine.getSnapshot(1).actionTip?.text).toBe("スタート！");
    expect(audio.music).toBe("game");

    expect(engine.togglePause()).toBe(GameState.Paused);
    expect(audio.paused).toBe(true);
    expect(engine.pauseToggle()).toBe(GameState.Playing);

    engine.restart(5);
    expect(engine.getSnapshot(5).score).toBe(0);
    expect(engine.getSnapshot(5).lives).toBe(5);
  });

  it("continues jumping while happiness is held", () => {
    const { engine } = createEngine();
    engine.start(0);
    engine.updateEmotion(emotion("happiness"), 0);
    expect(engine.getSnapshot(0).player.faceAction).toBe(GameAction.Jump);

    let now = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      now += 1 / 60;
      engine.updateEmotion(emotion("happiness"), now);
      engine.update(1 / 60, now);
    }

    const jumpActions = engine
      .drainEvents()
      .filter((event) => event.type === "action" && event.action === GameAction.Jump);
    expect(jumpActions.length).toBeGreaterThanOrEqual(2);
    expect(engine.getSnapshot(now).player.faceAction).toBe(GameAction.Jump);
  });

  it("finishes one jump, then immediately changes to the latest expression", () => {
    const { engine } = createEngine();
    engine.start(0);
    engine.updateEmotion(emotion("happiness"), 0);
    engine.updateEmotion(emotion("surprise"), 0.1);

    expect(engine.getSnapshot(0.1).player.faceAction).toBe(GameAction.Jump);
    expect(engine.getSnapshot(0.1).controller.heldAction).toBe(GameAction.Boost);

    let now = 0.1;
    for (let frame = 0; frame < 120; frame += 1) {
      now += 1 / 60;
      engine.updateEmotion(emotion("surprise"), now);
      engine.update(1 / 60, now);
      if (engine.getSnapshot(now).player.faceAction === GameAction.Boost) {
        break;
      }
    }

    expect(engine.getSnapshot(now).player.faceAction).toBe(GameAction.Boost);
    expect(engine.getSnapshot(now).player.boosting).toBe(true);
  });

  it("neutral during a jump prevents a second jump after landing", () => {
    const { engine } = createEngine();
    engine.start(0);
    engine.updateEmotion(emotion("happiness"), 0);
    engine.updateEmotion(emotion("neutral"), 0.1);

    let now = 0.1;
    for (let frame = 0; frame < 120; frame += 1) {
      now += 1 / 60;
      engine.update(1 / 60, now);
    }

    const snapshot = engine.getSnapshot(now);
    expect(snapshot.player.onGround).toBe(true);
    expect(snapshot.player.faceAction).toBeNull();
    expect(snapshot.controller.heldAction).toBeNull();
  });

  it("uses a shield once without losing a life", () => {
    const { engine } = createEngine();
    engine.start(0);
    engine.requestAction(GameAction.Shield, "keyboard", 0);
    engine.spawnObstacle("rock", TEST_SETTINGS.player.startX);
    engine.update(1 / 120, 0.01);

    expect(engine.getSnapshot(0.01).lives).toBe(5);
    expect(engine.drainEvents().some((event) => event.type === "shield-block")).toBe(true);
  });

  it("expires an old emotion without interrupting the current jump", () => {
    const { engine } = createEngine();
    engine.start(0);
    engine.updateEmotion(emotion("happiness"), 0);
    for (let frame = 1; frame <= 600; frame++) engine.update(1 / 60, frame / 60);
    expect(engine.getSnapshot(10).controller.heldAction).toBeNull();
    expect(engine.getSnapshot(10).player.onGround).toBe(true);
    expect(engine.drainEvents().filter((event) => event.type === "action")).toHaveLength(1);
  });

  it("freezes shield, invulnerability and cooldown during pause", () => {
    const { engine } = createEngine();
    engine.start(0);
    engine.requestAction(GameAction.Shield, "keyboard", 0);
    engine.player.takeDamage(0);
    engine.update(0.1, 0.1);
    const before = engine.getSnapshot(0.1);
    engine.togglePause(0.1);
    engine.update(0, 10.1);
    const paused = engine.getSnapshot(10.1);
    expect(paused.player.shielded).toBe(true);
    expect(paused.player.invulnerable).toBe(true);
    expect(paused.cooldowns).toEqual(before.cooldowns);
    expect(paused.elapsed).toBe(before.elapsed);
    engine.togglePause(10.1);
    engine.update(0.1, 10.2);
    expect(engine.getSnapshot(10.2).cooldowns.shield).toBeCloseTo(4.8);
    expect(engine.getSnapshot(10.2).player.shielded).toBe(true);
  });

  it("destroys a crate in the attack rectangle and awards its score", () => {
    const { engine, audio } = createEngine();
    engine.start(0);
    engine.drainEvents();
    engine.requestAction(GameAction.Attack, "keyboard", 0);
    engine.spawnObstacle("crate", 220);
    engine.update(1 / 120, 0.01);

    expect(engine.getSnapshot(0.01).obstacles).toHaveLength(0);
    expect(audio.sounds).toContain("destroy");
    const scoreEvent = engine
      .drainEvents()
      .find((event) => event.type === "score");
    expect(scoreEvent).toEqual({ type: "score", points: 165 });
  });

  it("awards 50 for a normal coin and 100 while boosting", () => {
    const normal = createEngine().engine;
    normal.start(0);
    normal.drainEvents();
    normal.spawnCoin(180, 570);
    normal.update(1 / 120, 0.01);
    const normalScore = normal
      .drainEvents()
      .find((event) => event.type === "score");

    const boosted = createEngine().engine;
    boosted.start(0);
    boosted.requestAction(GameAction.Boost, "keyboard", 0);
    boosted.drainEvents();
    boosted.spawnCoin(180, 570);
    boosted.update(1 / 120, 0.01);
    const boostedScore = boosted
      .drainEvents()
      .find((event) => event.type === "score");

    expect(normalScore).toEqual({ type: "score", points: 50 });
    expect(boostedScore).toEqual({ type: "score", points: 100 });
  });

  it("takes collision damage and resets an existing combo", () => {
    const { engine } = createEngine();
    engine.start(0);
    engine.spawnObstacle("rock", 0);
    engine.update(1 / 120, 0.01);
    expect(engine.getSnapshot(0.01).combo).toBe(1);

    engine.spawnObstacle("rock", TEST_SETTINGS.player.startX);
    engine.update(1 / 120, 0.02);
    const snapshot = engine.getSnapshot(0.02);

    expect(snapshot.lives).toBe(4);
    expect(snapshot.combo).toBe(0);
    expect(engine.drainEvents()).toContainEqual({ type: "damage", lives: 4 });
  });

  it("ends at zero lives and persists a non-decreasing high score", () => {
    const { engine, audio, storage } = createEngine();
    engine.start(0);
    let now = 0;
    for (let hit = 0; hit < 5; hit += 1) {
      for (let frame = 0; frame < 132; frame += 1) {
        now += 1 / 120;
        engine.update(1 / 120, now);
      }
      engine.spawnObstacle("rock", TEST_SETTINGS.player.startX);
      now += 1 / 120;
      engine.update(1 / 120, now);
    }

    const snapshot = engine.getSnapshot(now);
    expect(snapshot.state).toBe(GameState.GameOver);
    expect(snapshot.lives).toBe(0);
    expect(audio.sounds.at(-1)).toBe("death");

    const persisted = new HighScoreStorage(storage).load();
    expect(persisted).toBe(Math.trunc(snapshot.score));

    engine.restart(now + 1);
    const restarted = engine.getSnapshot(now + 1);
    expect(restarted.state).toBe(GameState.Playing);
    expect(restarted.lives).toBe(5);
    expect(restarted.score).toBe(0);
    expect(restarted.combo).toBe(0);
    expect(restarted.obstacles).toHaveLength(0);
    expect(restarted.coins).toHaveLength(0);
    expect(restarted.highScore).toBe(persisted);
  });

  it("produces identical scheduled entities for the same seed", () => {
    const settings: GameSettings = {
      ...DEFAULT_GAME_SETTINGS,
      spawning: {
        ...DEFAULT_GAME_SETTINGS.spawning,
        initialObstacleTime: 0,
        initialCoinTime: 0,
      },
    };
    const make = () =>
      new GameEngine({
        settings,
        seed: "same-seed",
        audio: new FakeAudio(),
        highScoreStorage: new HighScoreStorage(new MemoryStorage()),
      });
    const first = make();
    const second = make();
    first.start(0);
    second.start(0);

    for (let frame = 1; frame <= 60; frame += 1) {
      const now = frame / 60;
      first.update(1 / 60, now);
      second.update(1 / 60, now);
    }

    expect(first.getSnapshot(1).obstacles).toEqual(second.getSnapshot(1).obstacles);
    expect(first.getSnapshot(1).coins).toEqual(second.getSnapshot(1).coins);
  });

  it.each([12, 15, 30, 60, 120])(
    "preserves ten seconds, distance and score at %i rendering FPS",
    (fps) => {
      const run = (renderFps: number) => {
        const { engine } = createEngine();
        engine.setMode("keyboard");
        engine.start(0);
        for (let frame = 1; frame <= renderFps * 10; frame += 1) {
          engine.update(1 / renderFps, frame / renderFps);
        }
        return engine.getSnapshot(10);
      };
      const snapshot = run(fps);
      const reference = run(120);
      expect(snapshot.elapsed).toBeCloseTo(10, 8);
      expect(snapshot.gameTime).toBeCloseTo(snapshot.elapsed, 10);
      expect(snapshot.elapsed).toBe(reference.elapsed);
      expect(snapshot.distance).toBe(reference.distance);
      expect(snapshot.score).toBe(reference.score);
      expect(snapshot.player).toEqual(reference.player);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid fixed step %s rather than looping indefinitely", (step) => {
    expect(() => new GameEngine({ settings: { ...TEST_SETTINGS, window: { ...TEST_SETTINGS.window, simulationStepSeconds: step } } })).toThrow(RangeError);
  });

  it.each([12, 15, 30, 60, 120])(
    "uses the same keyboard skill duration and cooldown clock at %i rendering FPS",
    (fps) => {
      const { engine } = createEngine();
      engine.setMode("keyboard");
      engine.start(20);
      engine.requestAction(GameAction.Jump, "keyboard", 20);
      engine.requestAction(GameAction.Boost, "keyboard", 20);
      engine.requestAction(GameAction.Attack, "keyboard", 20);
      engine.requestAction(GameAction.Shield, "keyboard", 20);
      engine.player.takeDamage(20);
      for (let frame = 1; frame <= fps * 1.5; frame += 1) {
        engine.update(1 / fps, 20 + frame / fps);
      }
      // 15 FPSでは1.5秒が整数フレームにならない / 15 FPS下1.5秒不能整除，补齐最后的部分帧间隔。
      const previousWall = Math.floor(fps * 1.5) / fps;
      if (previousWall < 1.5) engine.update(1.5 - previousWall, 21.5);
      const active = engine.getSnapshot(21.5);
      expect(active.elapsed).toBeCloseTo(1.5, 8);
      expect(active.gameTime).toBeCloseTo(21.5, 8);
      expect(active.player.onGround).toBe(true);
      expect(active.player.boosting).toBe(true);
      expect(active.player.shielded).toBe(true);
      expect(active.player.attacking).toBe(false);
      expect(active.player.invulnerable).toBe(false);
      expect(active.cooldowns.boost).toBeCloseTo(2.5, 8);
      expect(active.cooldowns.shield).toBeCloseTo(3.5, 8);
      for (let frame = 1; frame <= fps; frame += 1) {
        engine.update(1 / fps, 21.5 + frame / fps);
      }
      const expired = engine.getSnapshot(22.5);
      expect(expired.player.boosting).toBe(false);
      expect(expired.player.shielded).toBe(false);
      expect(expired.cooldowns.boost).toBeCloseTo(1.5, 8);
      expect(expired.cooldowns.shield).toBeCloseTo(2.5, 8);
    },
  );

  it.each([GameAction.Jump, GameAction.Boost, GameAction.Attack, GameAction.Shield])(
    "repeats held %s on identical simulation steps across rendering rates",
    (action) => {
      const expression = {
        [GameAction.Jump]: "happiness",
        [GameAction.Boost]: "surprise",
        [GameAction.Attack]: "anger",
        [GameAction.Shield]: "sadness",
      } as const;
      const run = (fps: number) => {
        const { engine } = createEngine();
        engine.start(0);
        engine.updateEmotion(emotion(expression[action]), 0);
        for (let frame = 1; frame <= fps * 10; frame += 1) {
          engine.updateEmotion(emotion(expression[action]), (frame - 1) / fps);
          engine.update(1 / fps, frame / fps);
        }
        return {
          snapshot: engine.getSnapshot(10),
          actions: engine.drainEvents().filter((event) => event.type === "action"),
        };
      };
      const reference = run(120);
      expect(reference.actions.length).toBeGreaterThan(1);
      for (const fps of [12, 15, 30, 60]) {
        const result = run(fps);
        expect(result.actions).toEqual(reference.actions);
        expect(result.snapshot.player).toEqual(reference.snapshot.player);
        expect(result.snapshot.distance).toBe(reference.snapshot.distance);
        expect(result.snapshot.score).toBe(reference.snapshot.score);
      }
    },
  );

  it("substeps fast obstacles so a low-FPS frame cannot tunnel through the player", () => {
    const { engine } = createEngine();
    engine.setMode("keyboard");
    engine.start(0);
    engine.spawnObstacle("rock", 210);
    engine.update(0.25, 0.25);
    expect(engine.getSnapshot().lives).toBe(4);
    expect(engine.drainEvents()).toContainEqual({ type: "damage", lives: 4 });
  });

  it("bounds a long stall without advancing skills or cooldowns beyond physics", () => {
    const { engine } = createEngine();
    engine.setMode("keyboard");
    engine.start(0);
    engine.requestAction(GameAction.Shield, "keyboard", 0);
    engine.update(10, 10);
    const stalled = engine.getSnapshot(10);
    expect(stalled.elapsed).toBeCloseTo(TEST_SETTINGS.window.maxCatchUpSeconds, 8);
    expect(stalled.gameTime).toBeCloseTo(stalled.elapsed, 8);
    expect(stalled.player.shielded).toBe(true);
    expect(stalled.cooldowns.shield).toBeCloseTo(4.75, 8);
    // 将来の実時刻で読んでも技能を失効させない / 使用未来实际时间读取快照，也不能让技能提前过期。
    expect(engine.getSnapshot(100)).toEqual(stalled);
    engine.update(1 / 120, 10 + 1 / 120);
    expect(engine.getSnapshot().elapsed).toBeCloseTo(0.25 + 1 / 120, 8);
  });

  it("excludes paused wall time even when the caller's first resumed delta spans the pause", () => {
    const { engine } = createEngine();
    engine.start(0);
    engine.requestAction(GameAction.Shield, "keyboard", 0);
    engine.update(1 / 12, 1 / 12);
    const before = engine.getSnapshot();
    engine.togglePause(1 / 12);
    engine.update(10, 10 + 1 / 12);
    expect(engine.getSnapshot()).toEqual({ ...before, state: GameState.Paused });
    engine.togglePause(10 + 1 / 12);
    engine.update(10 + 1 / 12, 10 + 2 / 12);
    const resumed = engine.getSnapshot();
    expect(resumed.elapsed).toBeCloseTo(2 / 12, 8);
    expect(resumed.cooldowns.shield).toBeCloseTo(5 - 2 / 12, 8);
    expect(resumed.player.shielded).toBe(true);
  });

  it("clears a fractional accumulated step on restart and excludes pre-start time", () => {
    const { engine } = createEngine();
    engine.start(0);
    engine.update(1 / 240, 1 / 240);
    expect(engine.getSnapshot().elapsed).toBe(0);
    engine.restart(30);
    engine.update(30 + 1 / 240, 30 + 1 / 240);
    expect(engine.getSnapshot().elapsed).toBe(0);
    engine.update(1 / 240, 30 + 2 / 240);
    const restarted = engine.getSnapshot();
    expect(restarted.elapsed).toBeCloseTo(1 / 120, 8);
    expect(restarted.gameTime).toBeCloseTo(30 + 1 / 120, 8);
    expect(restarted.lives).toBe(5);
  });

  it("formats play time like the Python HUD", () => {
    expect(formatElapsedTime(9)).toBe("09.00秒");
    expect(formatElapsedTime(12.89)).toBe("12.89秒");
    expect(formatElapsedTime(69.99)).toBe("1分09秒");
  });
});
