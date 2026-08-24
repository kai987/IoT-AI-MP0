import { describe, expect, it } from "vitest";
import { ActionController } from "./ActionController";
import { DEFAULT_GAME_SETTINGS } from "./Settings";
import { GameAction, type EmotionSample, type FacialFeatures } from "./types";

const EMPTY_FEATURES: FacialFeatures = {
  mouthOpenRatio: 0,
  jawOpen: 0,
  browRaise: 0,
  browFurrow: 0,
  smile: 0,
  eyeWide: 0,
};

function sample(
  emotion: EmotionSample["emotion"],
  confidence = 0.85,
  features: FacialFeatures | null = EMPTY_FEATURES,
): EmotionSample {
  return { emotion, confidence, features, uncertain: emotion === null };
}

describe("ActionController", () => {
  it.each([
    ["happiness", GameAction.Jump, { ...EMPTY_FEATURES, smile: 0.3 }],
    ["surprise", GameAction.Boost, { ...EMPTY_FEATURES, jawOpen: 0.3 }],
    ["anger", GameAction.Attack, { ...EMPTY_FEATURES, browFurrow: 0.8 }],
    ["sadness", GameAction.Shield, EMPTY_FEATURES],
  ] as const)("maps %s to %s", (emotion, expectedAction, features) => {
    const controller = new ActionController();
    const decision = controller.update(sample(emotion, 0.55, features), 1);

    expect(decision?.action).toBe(expectedAction);
    expect(decision?.source).toBe("face");
    expect(controller.heldAction).toBe(expectedAction);
  });

  it("neutral immediately clears a continuous face action", () => {
    const controller = new ActionController();
    controller.update(sample("happiness", 0.9), 1);

    controller.update(sample("neutral", 0.9), 1.1);

    expect(controller.heldAction).toBeNull();
    expect(controller.getSnapshot().statusMessage).toContain("通常走行");
  });

  it("keeps an action through the 0.45 second uncertain grace period", () => {
    const controller = new ActionController();
    controller.update(sample("surprise", 0.9), 1);

    controller.update(sample(null), 1.1);
    expect(controller.heldAction).toBe(GameAction.Boost);

    controller.update(sample(null), 1.54);
    expect(controller.heldAction).toBe(GameAction.Boost);

    controller.update(sample(null), 1.56);
    expect(controller.heldAction).toBeNull();
  });

  it("requires auxiliary happiness evidence below strong confidence", () => {
    const controller = new ActionController();
    const weak = controller.update(sample("happiness", 0.55), 1);
    const supported = controller.update(
      sample("happiness", 0.55, {
        ...EMPTY_FEATURES,
        smile: DEFAULT_GAME_SETTINGS.recognition.happinessSmileThreshold,
      }),
      2,
    );

    expect(weak).toBeNull();
    expect(supported?.action).toBe(GameAction.Jump);
  });

  it.each([
    ["happiness", GameAction.Jump],
    ["surprise", GameAction.Boost],
    ["anger", GameAction.Attack],
  ] as const)(
    "rejects low-confidence %s without features but accepts strong classifier confidence",
    (emotion, expectedAction) => {
      const controller = new ActionController();
      const lowConfidence = controller.update(sample(emotion, 0.55, null), 1);
      const strongConfidence = controller.update(sample(emotion, 0.8, null), 2);

      expect(lowConfidence).toBeNull();
      expect(strongConfidence?.action).toBe(expectedAction);
    },
  );

  it("applies independent keyboard cooldowns", () => {
    const controller = new ActionController();
    expect(controller.requestKeyboard(GameAction.Attack, 1)).not.toBeNull();
    expect(controller.requestKeyboard(GameAction.Attack, 1.2)).toBeNull();
    expect(controller.cooldownRemaining(GameAction.Attack, 1.2)).toBeCloseTo(1.3);
    expect(controller.requestKeyboard(GameAction.Jump, 1.2)).not.toBeNull();
    expect(controller.requestKeyboard(GameAction.Attack, 2.5)).not.toBeNull();
  });
});
