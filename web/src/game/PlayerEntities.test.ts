import { describe, expect, it } from "vitest";
import { Coin, Obstacle, SeededRandom } from "./Entities";
import { Player } from "./Player";
import { DEFAULT_GAME_SETTINGS } from "./Settings";
import { GameAction } from "./types";

describe("Player", () => {
  it("starts with five lives and lands after a jump", () => {
    const player = new Player();
    expect(player.lives).toBe(5);
    expect(player.jump()).toBe(true);
    expect(player.jump()).toBe(false);

    let now = 0;
    for (let frame = 0; frame < 180; frame += 1) {
      now += 1 / 60;
      player.update(1 / 60, now);
    }

    expect(player.onGround).toBe(true);
    expect(player.y).toBe(
      DEFAULT_GAME_SETTINGS.player.groundY - DEFAULT_GAME_SETTINGS.player.height,
    );
  });

  it("does not interrupt a face action before its cycle completes", () => {
    const player = new Player();
    expect(player.startFaceAction(GameAction.Boost, 1)).toBe(true);
    expect(player.startFaceAction(GameAction.Shield, 1.5)).toBe(false);
    expect(player.faceActionIsComplete(2.99)).toBe(false);
    expect(player.faceActionIsComplete(3)).toBe(true);

    player.finishFaceAction();
    expect(player.startFaceAction(GameAction.Shield, 3)).toBe(true);
  });

  it("consumes one shield without losing a life", () => {
    const player = new Player();
    player.activateShield(1);
    expect(player.hasShield(1.1)).toBe(true);
    player.consumeShield(1.1);

    expect(player.hasShield(1.1)).toBe(false);
    expect(player.lives).toBe(5);
  });
});

describe("Entities and seeded random", () => {
  it("marks only crates and enemies as destructible", () => {
    expect(new Obstacle(1, "crate", 100).destructible).toBe(true);
    expect(new Obstacle(2, "enemy", 100).destructible).toBe(true);
    expect(new Obstacle(3, "rock", 100).destructible).toBe(false);
    expect(new Obstacle(4, "barrier", 100).destructible).toBe(false);
  });

  it("scrolls obstacles and coins to the left", () => {
    const obstacle = new Obstacle(1, "rock", 500);
    const coin = new Coin(2, 500, 300);
    obstacle.update(0.5, 200);
    coin.update(0.5, 200);

    expect(obstacle.x).toBe(400);
    expect(coin.x).toBe(400);
  });

  it("reproduces a random sequence for the same seed", () => {
    const first = new SeededRandom("demo-seed");
    const second = new SeededRandom("demo-seed");
    const firstValues = Array.from({ length: 12 }, () => first.next());
    const secondValues = Array.from({ length: 12 }, () => second.next());

    expect(firstValues).toEqual(secondValues);
    expect(new Set(firstValues).size).toBeGreaterThan(1);
  });
});
