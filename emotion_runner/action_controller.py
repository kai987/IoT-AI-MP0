"""Convert stable facial expressions into continuous game actions."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from . import settings


class FeatureValues(Protocol):
    mouth_open_ratio: float
    jaw_open: float
    brow_raise: float
    brow_furrow: float
    smile: float
    eye_wide: float


class GameAction(str, Enum):
    JUMP = "jump"
    BOOST = "boost"
    ATTACK = "attack"
    SHIELD = "shield"


EMOTION_TO_ACTION = {
    "surprise": GameAction.BOOST,
    "happiness": GameAction.JUMP,
    "anger": GameAction.ATTACK,
    "sadness": GameAction.SHIELD,
}

ACTION_COOLDOWNS = {
    GameAction.JUMP: settings.JUMP_COOLDOWN,
    GameAction.BOOST: settings.BOOST_COOLDOWN,
    GameAction.ATTACK: settings.ATTACK_COOLDOWN,
    GameAction.SHIELD: settings.SHIELD_COOLDOWN,
}


@dataclass(frozen=True)
class EmotionSample:
    emotion: str | None
    confidence: float = 0.0
    features: FeatureValues | None = None
    uncertain: bool = False


@dataclass(frozen=True)
class ActionDecision:
    action: GameAction
    source: str
    emotion: str | None


class ActionController:
    """Maintain a facial action while the corresponding expression is held.

    Keyboard actions remain one-shot and use cooldowns. Facial actions are
    level-triggered: they continue until another stable expression is seen.
    """

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.held_action: GameAction | None = None
        self.held_emotion: str | None = None
        self.uncertain_since: float | None = None
        self.next_ready = {action: 0.0 for action in GameAction}
        self.last_action: GameAction | None = None
        self.last_source = ""
        self.status_message = "表情操作の準備完了"

    def update(self, sample: EmotionSample, now: float) -> ActionDecision | None:
        if sample.uncertain or sample.emotion is None:
            self._handle_uncertain(now, "判定不能：表情を保持してください")
            return None

        if sample.emotion == "neutral":
            self.uncertain_since = None
            self._clear_held_action()
            self.status_message = "無表情：通常走行"
            return None

        action = EMOTION_TO_ACTION.get(sample.emotion)
        if action is None:
            self.uncertain_since = None
            self._clear_held_action()
            self.status_message = f"{sample.emotion}：割り当て動作なし"
            return None

        if self.held_action == action and self.held_emotion == sample.emotion:
            self.uncertain_since = None
            self.status_message = f"{action.value.upper()} 継続中"
            return None
        if sample.confidence < settings.ACTION_CONFIDENCE_THRESHOLD:
            self._handle_uncertain(
                now,
                f"確信度不足 {sample.confidence:.0%}",
            )
            return None
        if not self._features_support(sample):
            self._handle_uncertain(
                now,
                f"{sample.emotion}：口・眉特徴の確認待ち",
            )
            return None

        self.held_action = action
        self.held_emotion = sample.emotion
        self.uncertain_since = None
        self.last_action = action
        self.last_source = "face"
        self.status_message = f"{action.value.upper()} 継続開始"
        return ActionDecision(action=action, source="face", emotion=sample.emotion)

    def request_keyboard(
        self,
        action: GameAction,
        now: float,
    ) -> ActionDecision | None:
        remaining = self.cooldown_remaining(action, now)
        if remaining > 0.0:
            self.status_message = f"{action.value} クールダウン {remaining:.1f}s"
            return None
        return self._accept_keyboard(action, now)

    def cooldown_remaining(self, action: GameAction, now: float) -> float:
        return max(0.0, self.next_ready[action] - now)

    def _accept_keyboard(
        self,
        action: GameAction,
        now: float,
    ) -> ActionDecision:
        self.next_ready[action] = now + ACTION_COOLDOWNS[action]
        self.last_action = action
        self.last_source = "keyboard"
        self.status_message = f"{action.value.upper()} 発動 (keyboard)"
        return ActionDecision(action=action, source="keyboard", emotion=None)

    def _handle_uncertain(self, now: float, message: str) -> None:
        if self.uncertain_since is None:
            self.uncertain_since = now
        elapsed = now - self.uncertain_since
        if elapsed >= settings.FACE_ACTION_LOSS_GRACE:
            self._clear_held_action()
            self.status_message = message
        elif self.held_action is not None:
            remaining = settings.FACE_ACTION_LOSS_GRACE - elapsed
            self.status_message = f"{message}（動作保持 {remaining:.1f}s）"
        else:
            self.status_message = message

    def _clear_held_action(self) -> None:
        self.held_action = None
        self.held_emotion = None

    @staticmethod
    def _features_support(sample: EmotionSample) -> bool:
        features = sample.features
        if sample.emotion == "sadness":
            return True
        if features is None:
            return sample.confidence >= settings.STRONG_CLASSIFIER_CONFIDENCE
        if sample.emotion == "surprise":
            return any(
                (
                    features.mouth_open_ratio
                    >= settings.SURPRISE_MOUTH_RATIO_THRESHOLD,
                    features.jaw_open >= settings.SURPRISE_JAW_OPEN_THRESHOLD,
                    features.eye_wide >= settings.SURPRISE_EYE_WIDE_THRESHOLD,
                    features.brow_raise >= settings.SURPRISE_BROW_RAISE_THRESHOLD,
                    sample.confidence >= settings.STRONG_CLASSIFIER_CONFIDENCE,
                )
            )
        if sample.emotion == "happiness":
            return (
                features.smile >= settings.HAPPINESS_SMILE_THRESHOLD
                or sample.confidence >= settings.STRONG_CLASSIFIER_CONFIDENCE
            )
        if sample.emotion == "anger":
            return (
                features.brow_furrow >= settings.ANGER_BROW_FURROW_THRESHOLD
                or sample.confidence >= settings.STRONG_CLASSIFIER_CONFIDENCE
            )
        return True
