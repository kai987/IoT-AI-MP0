"""Tests for Emotion Runner controls, physics, and entities."""

from __future__ import annotations

from dataclasses import dataclass
import os
import unittest

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

import pygame

from emotion_runner.action_controller import (
    ActionController,
    EmotionSample,
    GameAction,
)
from emotion_runner.audio import AudioManager
from emotion_runner.camera_worker import (
    CameraSnapshot,
    FeatureSnapshot,
    NoCameraProvider,
)
from emotion_runner.entities import Coin, Obstacle
from emotion_runner.game import EmotionRunnerGame
from emotion_runner.player import Player
from emotion_runner import settings


@dataclass(frozen=True)
class Features:
    mouth_open_ratio: float = 0.0
    jaw_open: float = 0.0
    brow_raise: float = 0.0
    brow_furrow: float = 0.0
    smile: float = 0.0
    eye_wide: float = 0.0


class ActionControllerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.controller = ActionController()

    def test_surprise_with_open_mouth_triggers_boost(self) -> None:
        decision = self.controller.update(
            EmotionSample(
                emotion="surprise",
                confidence=max(settings.ACTION_CONFIDENCE_THRESHOLD, 0.55),
                features=Features(
                    mouth_open_ratio=settings.SURPRISE_MOUTH_RATIO_THRESHOLD
                    + 0.01
                ),
            ),
            now=10.0,
        )

        self.assertIsNotNone(decision)
        self.assertEqual(decision.action, GameAction.BOOST)
        self.assertEqual(decision.source, "face")

    def test_expression_remains_active_while_it_is_held(self) -> None:
        sample = EmotionSample(
            emotion="surprise",
            confidence=0.80,
            features=Features(),
        )
        self.assertIsNotNone(self.controller.update(sample, now=1.0))
        self.assertIsNone(self.controller.update(sample, now=3.0))
        self.assertEqual(self.controller.held_action, GameAction.BOOST)

    def test_neutral_stops_continuous_expression_action(self) -> None:
        self.controller.update(
            EmotionSample("surprise", 0.80, Features()),
            now=1.0,
        )
        self.controller.update(EmotionSample("neutral", 0.80), now=1.1)

        self.assertIsNone(self.controller.held_action)

    def test_switching_expression_switches_continuous_action(self) -> None:
        self.controller.update(
            EmotionSample("surprise", 0.80, Features()),
            now=1.0,
        )
        decision = self.controller.update(
            EmotionSample("happiness", 0.80, Features(smile=0.40)),
            now=1.2,
        )

        self.assertIsNotNone(decision)
        self.assertEqual(decision.action, GameAction.JUMP)
        self.assertEqual(self.controller.held_action, GameAction.JUMP)

    def test_brief_uncertainty_keeps_action_then_releases_it(self) -> None:
        self.controller.update(
            EmotionSample("surprise", 0.80, Features()),
            now=1.0,
        )
        uncertain = EmotionSample(None, uncertain=True)
        self.controller.update(uncertain, now=1.1)
        self.assertEqual(self.controller.held_action, GameAction.BOOST)

        self.controller.update(uncertain, now=1.6)
        self.assertIsNone(self.controller.held_action)

    def test_uncertain_emotion_does_not_trigger(self) -> None:
        decision = self.controller.update(
            EmotionSample(
                emotion="happiness",
                confidence=0.95,
                features=Features(smile=0.5),
                uncertain=True,
            ),
            now=1.0,
        )

        self.assertIsNone(decision)
        self.assertIn("判定不能", self.controller.status_message)

    def test_happiness_needs_smile_or_strong_classifier_score(self) -> None:
        weak = self.controller.update(
            EmotionSample(
                emotion="happiness",
                confidence=0.55,
                features=Features(smile=0.02),
            ),
            now=1.0,
        )
        strong = self.controller.update(
            EmotionSample(
                emotion="happiness",
                confidence=0.80,
                features=Features(smile=0.02),
            ),
            now=2.0,
        )

        self.assertIsNone(weak)
        self.assertIsNotNone(strong)
        self.assertEqual(strong.action, GameAction.JUMP)

    def test_keyboard_respects_ability_cooldown(self) -> None:
        first = self.controller.request_keyboard(GameAction.ATTACK, now=1.0)
        blocked = self.controller.request_keyboard(GameAction.ATTACK, now=1.2)
        later = self.controller.request_keyboard(GameAction.ATTACK, now=3.0)

        self.assertIsNotNone(first)
        self.assertIsNone(blocked)
        self.assertIsNotNone(later)


class AudioManagerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.audio = AudioManager()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.audio.shutdown()

    def test_music_and_all_required_effects_are_generated(self) -> None:
        self.assertTrue(self.audio.enabled, self.audio.error)
        self.assertEqual(set(self.audio.music), {"menu", "game"})
        required = {
            "click",
            "start",
            "score",
            "jump",
            "boost",
            "attack",
            "shield",
            "destroy",
            "shield_block",
            "hit",
            "death",
            "pause",
            "resume",
            "error",
        }
        self.assertTrue(required.issubset(self.audio.sounds))
        self.assertTrue(all(sound.get_length() > 0 for sound in self.audio.sounds.values()))

    def test_music_switch_pause_and_mute_are_safe(self) -> None:
        self.audio.play_music("menu")
        self.assertEqual(self.audio.current_music, "menu")
        self.audio.play_music("game")
        self.assertEqual(self.audio.current_music, "game")
        self.audio.set_paused(True)
        self.assertTrue(self.audio.paused)
        self.assertTrue(self.audio.toggle_mute())
        self.assertFalse(self.audio.toggle_mute())

    def test_master_volume_is_clamped_and_adjustment_unmutes(self) -> None:
        self.assertAlmostEqual(self.audio.set_volume(0.8), 0.8)
        self.assertAlmostEqual(self.audio.adjust_volume(-0.1), 0.7)
        self.assertEqual(self.audio.volume_percent, 70)
        self.assertAlmostEqual(self.audio.set_volume(3.0), 1.0)
        self.assertAlmostEqual(self.audio.set_volume(-2.0), 0.0)
        self.audio.toggle_mute()
        self.audio.adjust_volume(0.1)
        self.assertFalse(self.audio.muted)


class HudFormattingTests(unittest.TestCase):
    def test_elapsed_time_uses_seconds_then_minutes(self) -> None:
        self.assertEqual(
            EmotionRunnerGame._format_elapsed_time(9.0),
            "09.00秒",
        )
        self.assertEqual(
            EmotionRunnerGame._format_elapsed_time(12.89),
            "12.89秒",
        )
        self.assertEqual(
            EmotionRunnerGame._format_elapsed_time(69.99),
            "1分09秒",
        )


class SettingsTests(unittest.TestCase):
    def test_requested_frame_and_enemy_timing_settings_are_valid(self) -> None:
        self.assertEqual(settings.TARGET_FPS, 120)
        self.assertEqual(settings.ANALYZE_EVERY_N_FRAMES, 2)
        self.assertGreater(settings.ENEMY_SPAWN_TIME, 0.0)

    def test_hud_width_and_action_tip_clearance(self) -> None:
        self.assertEqual(settings.HUD_WIDTH, 700)
        hud_bottom = settings.HUD_Y + settings.HUD_HEIGHT
        tip_top = settings.ACTION_TIP_CENTER_Y - settings.ACTION_TIP_HEIGHT // 2
        self.assertGreater(tip_top, hud_bottom)

    def test_adjustable_runtime_defaults_are_valid(self) -> None:
        self.assertTrue(
            settings.CAMERA_INDEX is None
            or isinstance(settings.CAMERA_INDEX, int)
        )
        self.assertLessEqual(
            settings.AUDIO_MIN_VOLUME,
            settings.AUDIO_MASTER_VOLUME,
        )
        self.assertLessEqual(
            settings.AUDIO_MASTER_VOLUME,
            settings.AUDIO_MAX_VOLUME,
        )
        self.assertGreater(settings.AUDIO_VOLUME_STEP, 0.0)


class GameActionQueueTests(unittest.TestCase):
    def make_game(self) -> EmotionRunnerGame:
        game = EmotionRunnerGame(NoCameraProvider(), seed=1)
        game.start_new_game()
        game.next_obstacle_at = 999.0
        game.next_coin_at = 999.0
        return game

    @staticmethod
    def snapshot(emotion: str) -> CameraSnapshot:
        return CameraSnapshot(
            status="running",
            emotion=emotion,
            confidence=0.85,
            uncertain=False,
            features=FeatureSnapshot(0.3, 0.3, 0.3, 0.3, 0.3, 0.3),
        )

    def test_leaving_happiness_midair_allows_exactly_one_jump(self) -> None:
        game = self.make_game()
        now = 1.0
        game.snapshot = self.snapshot("happiness")
        game._update(1 / 60, now)
        self.assertEqual(game.player.face_action, GameAction.JUMP)

        game.snapshot = self.snapshot("neutral")
        now += 1 / 60
        game._update(1 / 60, now)
        self.assertEqual(game.player.face_action, GameAction.JUMP)
        self.assertIsNone(game.controller.held_action)

        for _ in range(90):
            now += 1 / 60
            game._update(1 / 60, now)

        self.assertTrue(game.player.on_ground)
        self.assertIsNone(game.player.face_action)

    def test_latest_expression_starts_as_soon_as_jump_finishes(self) -> None:
        game = self.make_game()
        now = 1.0
        game.snapshot = self.snapshot("happiness")
        game._update(1 / 60, now)

        game.snapshot = self.snapshot("surprise")
        now += 1 / 60
        game._update(1 / 60, now)
        self.assertEqual(game.controller.held_action, GameAction.BOOST)
        self.assertEqual(game.player.face_action, GameAction.JUMP)

        for _ in range(90):
            now += 1 / 60
            game._update(1 / 60, now)
            if game.player.face_action == GameAction.BOOST:
                break

        self.assertTrue(game.player.on_ground)
        self.assertEqual(game.player.face_action, GameAction.BOOST)
        self.assertTrue(game.player.is_boosting(now))

    def test_menu_volume_buttons_change_master_volume(self) -> None:
        game = EmotionRunnerGame(NoCameraProvider(), seed=1)
        game.audio.set_volume(0.8)
        pygame.event.post(
            pygame.event.Event(
                pygame.MOUSEBUTTONDOWN,
                button=1,
                pos=game.volume_down_rect.center,
            )
        )
        game._handle_events(now=1.0)
        self.assertEqual(game.audio.volume_percent, 70)

        pygame.event.post(
            pygame.event.Event(
                pygame.MOUSEBUTTONDOWN,
                button=1,
                pos=game.volume_up_rect.center,
            )
        )
        game._handle_events(now=1.1)
        self.assertEqual(game.audio.volume_percent, 80)


class PlayerTests(unittest.TestCase):
    def test_player_starts_with_five_lives(self) -> None:
        self.assertEqual(settings.INITIAL_LIVES, 5)
        self.assertEqual(Player().lives, 5)

    def test_jump_returns_to_ground(self) -> None:
        player = Player()
        self.assertTrue(player.jump())
        self.assertFalse(player.jump())

        now = 0.0
        for _ in range(180):
            now += 1 / 60
            player.update(1 / 60, now)

        self.assertTrue(player.on_ground)
        self.assertAlmostEqual(
            player.y,
            settings.GROUND_Y - settings.PLAYER_HEIGHT,
        )

    def test_shield_can_be_consumed_without_losing_life(self) -> None:
        player = Player()
        player.activate_shield(now=1.0)
        self.assertTrue(player.has_shield(now=1.1))
        player.consume_shield(now=1.1)

        self.assertFalse(player.has_shield(now=1.1))
        self.assertEqual(player.lives, settings.INITIAL_LIVES)

    def test_face_action_cycle_cannot_be_interrupted(self) -> None:
        player = Player()
        self.assertTrue(player.start_face_action(GameAction.BOOST, now=1.0))
        self.assertTrue(player.is_boosting(now=1.5))
        self.assertFalse(player.start_face_action(GameAction.SHIELD, now=1.5))

        self.assertTrue(player.face_action_is_complete(now=3.0))
        player.finish_face_action()
        self.assertTrue(player.start_face_action(GameAction.SHIELD, now=3.0))
        self.assertFalse(player.is_boosting(now=3.1))
        self.assertTrue(player.has_shield(now=3.1))

        player.finish_face_action()
        self.assertFalse(player.has_shield(now=3.1))


class EntityTests(unittest.TestCase):
    def test_only_crate_and_enemy_are_attack_destructible(self) -> None:
        self.assertTrue(Obstacle("crate", 100).destructible)
        self.assertTrue(Obstacle("enemy", 100).destructible)
        self.assertFalse(Obstacle("rock", 100).destructible)
        self.assertFalse(Obstacle("barrier", 100).destructible)

    def test_entities_scroll_left(self) -> None:
        obstacle = Obstacle("rock", 500)
        coin = Coin(500, 300)
        obstacle.update(0.5, 200)
        coin.update(0.5, 200)

        self.assertEqual(obstacle.x, 400)
        self.assertEqual(coin.x, 400)


if __name__ == "__main__":
    pygame.init()
    unittest.main()
