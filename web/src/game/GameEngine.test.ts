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
      now += 1.1;
      engine.spawnObstacle("rock", TEST_SETTINGS.player.startX);
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

  it("formats play time like the Python HUD", () => {
    expect(formatElapsedTime(9)).toBe("09.00秒");
    expect(formatElapsedTime(12.89)).toBe("12.89秒");
    expect(formatElapsedTime(69.99)).toBe("1分09秒");
  });
});
