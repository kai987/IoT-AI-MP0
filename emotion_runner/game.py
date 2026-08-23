"""The complete first-version Emotion Runner game loop."""

from __future__ import annotations

from enum import Enum
import json
import math
from pathlib import Path
import random
import time
from typing import Protocol

import numpy as np
import pygame

from . import settings
from . import app_paths
from .action_controller import (
    ActionController,
    ActionDecision,
    EmotionSample,
    GameAction,
)
from .audio import AudioManager
from .camera_worker import CameraSnapshot
from .entities import Coin, Obstacle
from .player import Player


class CameraProvider(Protocol):
    def latest(self) -> CameraSnapshot: ...


class GameState(str, Enum):
    MENU = "menu"
    PLAYING = "playing"
    PAUSED = "paused"
    GAME_OVER = "game_over"


ACTION_PRESENTATION = {
    GameAction.JUMP: ("SPACE", "喜び", "ジャンプ", settings.CYAN),
    GameAction.BOOST: ("S", "驚き", "ブースト", settings.YELLOW),
    GameAction.ATTACK: ("A", "怒り", "攻撃", settings.ORANGE),
    GameAction.SHIELD: ("D", "悲しみ", "シールド", settings.PURPLE),
}

EMOTION_JA = {
    "neutral": "無表情",
    "happiness": "喜び",
    "surprise": "驚き",
    "sadness": "悲しみ",
    "anger": "怒り",
    "disgust": "嫌悪",
    "fear": "恐れ",
    "contempt": "軽蔑",
}


class EmotionRunnerGame:
    """A responsive 1280x720 runner controlled by face or keyboard."""

    def __init__(
        self,
        camera: CameraProvider,
        seed: int | None = None,
    ) -> None:
        pygame.init()
        pygame.display.set_caption(settings.WINDOW_TITLE)
        self.screen = pygame.display.set_mode(
            (settings.WINDOW_WIDTH, settings.WINDOW_HEIGHT)
        )
        self.clock = pygame.time.Clock()
        self.audio = AudioManager()
        self.camera = camera
        self.random = random.Random(seed)
        self.font_small = self._load_font(18)
        self.font_body = self._load_font(24)
        self.font_medium = self._load_font(32)
        self.font_large = self._load_font(54)
        self.font_menu_title = self._load_font(64)
        self.font_title = self._load_font(76)
        self.sky = self._create_sky()

        self.state = GameState.MENU
        self.running = True
        self.player = Player()
        self.controller = ActionController()
        self.obstacles: list[Obstacle] = []
        self.coins: list[Coin] = []
        self.score = 0.0
        self.combo = 0
        self.best_combo = 0
        self.elapsed = 0.0
        self.distance = 0.0
        self.current_speed = settings.BASE_SCROLL_SPEED
        self.next_obstacle_at = 1.2
        self.next_coin_at = 1.7
        self.last_action_text = ""
        self.last_action_until = 0.0
        self.high_score = self._load_high_score()
        self.snapshot = CameraSnapshot()
        self.start_button_rect = pygame.Rect(420, 432, 440, 68)
        self.restart_button_rect = pygame.Rect(415, 432, 450, 66)
        self.volume_down_rect = pygame.Rect(500, 512, 54, 42)
        self.volume_up_rect = pygame.Rect(726, 512, 54, 42)
        self.audio.play_music("menu")

    def start_new_game(self) -> None:
        self.player.reset()
        self.controller.reset()
        self.obstacles.clear()
        self.coins.clear()
        self.score = 0.0
        self.combo = 0
        self.best_combo = 0
        self.elapsed = 0.0
        self.distance = 0.0
        self.current_speed = settings.BASE_SCROLL_SPEED
        self.next_obstacle_at = 1.2
        self.next_coin_at = 1.7
        self.last_action_text = "スタート！"
        self.last_action_until = (
            time.perf_counter() + settings.ACTION_TIP_START_DURATION
        )
        self.state = GameState.PLAYING
        self.audio.set_paused(False)
        self.audio.play_music("game")
        self.audio.play("start")

    def run(self, max_frames: int | None = None) -> None:
        frame_count = 0
        while self.running:
            delta_time = min(0.05, self.clock.tick(settings.TARGET_FPS) / 1000.0)
            now = time.perf_counter()
            self.snapshot = self.camera.latest()
            self._handle_events(now)
            if self.state == GameState.PLAYING:
                self._update(delta_time, now)
            self._draw(now)
            pygame.display.flip()

            frame_count += 1
            if max_frames is not None and frame_count >= max_frames:
                self.running = False

    def _handle_events(self, now: float) -> None:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                self.running = False
                continue
            if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                if (
                    self.state == GameState.MENU
                    and self.start_button_rect.collidepoint(event.pos)
                ):
                    self.audio.play("click")
                    self.start_new_game()
                elif (
                    self.state == GameState.MENU
                    and self.volume_down_rect.collidepoint(event.pos)
                ):
                    self.audio.adjust_volume(-settings.AUDIO_VOLUME_STEP)
                    self.audio.play("click")
                elif (
                    self.state == GameState.MENU
                    and self.volume_up_rect.collidepoint(event.pos)
                ):
                    self.audio.adjust_volume(settings.AUDIO_VOLUME_STEP)
                    self.audio.play("click")
                elif (
                    self.state == GameState.GAME_OVER
                    and self.restart_button_rect.collidepoint(event.pos)
                ):
                    self.audio.play("click")
                    self.start_new_game()
                continue
            if event.type != pygame.KEYDOWN:
                continue

            if event.key == pygame.K_ESCAPE:
                self.audio.play("click")
                self.running = False
            elif event.key == pygame.K_m:
                muted = self.audio.toggle_mute()
                if not muted:
                    self.audio.play("click")
                self._flash("ミュート ON" if muted else "ミュート OFF", now)
            elif self.state == GameState.MENU and event.key in (
                pygame.K_RETURN,
                pygame.K_SPACE,
            ):
                self.audio.play("click")
                self.start_new_game()
            elif self.state == GameState.GAME_OVER and event.key in (
                pygame.K_r,
                pygame.K_RETURN,
            ):
                self.audio.play("click")
                self.start_new_game()
            elif event.key == pygame.K_p:
                if self.state == GameState.PLAYING:
                    self.state = GameState.PAUSED
                    self.audio.set_paused(True)
                elif self.state == GameState.PAUSED:
                    self.state = GameState.PLAYING
                    self.audio.set_paused(False)
            elif self.state == GameState.PLAYING:
                keyboard_actions = {
                    pygame.K_SPACE: GameAction.JUMP,
                    pygame.K_s: GameAction.BOOST,
                    pygame.K_a: GameAction.ATTACK,
                    pygame.K_d: GameAction.SHIELD,
                }
                action = keyboard_actions.get(event.key)
                if action is not None:
                    self._apply_decision(
                        self.controller.request_keyboard(action, now), now
                    )

    def _update(self, delta_time: float, now: float) -> None:
        self.elapsed += delta_time
        sample = EmotionSample(
            emotion=self.snapshot.emotion,
            confidence=self.snapshot.confidence,
            features=self.snapshot.features,
            uncertain=self.snapshot.uncertain,
        )
        self.controller.update(sample, now)
        self._advance_face_action(now)

        base_speed = min(
            settings.MAX_SCROLL_SPEED,
            settings.BASE_SCROLL_SPEED
            + self.elapsed * settings.SPEED_INCREASE_PER_SECOND,
        )
        speed_multiplier = (
            settings.BOOST_SPEED_MULTIPLIER
            if self.player.is_boosting(now)
            else 1.0
        )
        self.current_speed = base_speed * speed_multiplier
        self.distance += self.current_speed * delta_time
        self.score += self.current_speed * delta_time * 0.10
        self.player.update(delta_time, now)
        # A jump can finish during the physics update. Switch on that same frame.
        self._advance_face_action(now)

        if self.elapsed >= self.next_obstacle_at:
            self._spawn_obstacle()
        if self.elapsed >= self.next_coin_at:
            self._spawn_coin_group()

        for obstacle in self.obstacles:
            obstacle.update(delta_time, self.current_speed)
        for coin in self.coins:
            coin.update(delta_time, self.current_speed)

        self._resolve_attacks(now)
        self._resolve_player_collisions(now)
        self._resolve_coin_collisions(now)
        self._resolve_passed_obstacles()
        # A shield cycle can end when it absorbs a collision.
        self._advance_face_action(now)
        self.obstacles = [
            obstacle
            for obstacle in self.obstacles
            if obstacle.alive and not obstacle.is_offscreen()
        ]
        self.coins = [coin for coin in self.coins if coin.alive and not coin.is_offscreen()]

        if self.player.lives <= 0:
            self.state = GameState.GAME_OVER
            self.audio.play_music(None)
            self.audio.play("death")
            self.high_score = max(self.high_score, int(self.score))
            self._save_high_score(self.high_score)

    def _spawn_obstacle(self) -> None:
        if self.elapsed < settings.ENEMY_SPAWN_TIME:
            choices = ("rock", "rock", "rock")
        elif self.elapsed < 60.0:
            choices = ("rock", "crate", "crate", "enemy")
        else:
            choices = ("rock", "crate", "enemy", "barrier")
        self.obstacles.append(
            Obstacle(self.random.choice(choices), settings.WINDOW_WIDTH + 35)
        )
        difficulty = min(0.35, self.elapsed / 240.0)
        interval = self.random.uniform(
            settings.OBSTACLE_MIN_INTERVAL,
            settings.OBSTACLE_MAX_INTERVAL,
        )
        self.next_obstacle_at = self.elapsed + max(0.82, interval - difficulty)

    def _spawn_coin_group(self) -> None:
        count = self.random.randint(3, 6)
        high = self.random.random() < 0.48
        base_y = settings.GROUND_Y - (176 if high else 72)
        start_x = settings.WINDOW_WIDTH + 30
        for index in range(count):
            arc = -24.0 * math.sin(math.pi * index / max(1, count - 1))
            self.coins.append(Coin(start_x + index * 42, base_y + arc))
        self.next_coin_at = self.elapsed + self.random.uniform(
            settings.COIN_MIN_INTERVAL,
            settings.COIN_MAX_INTERVAL,
        )

    def _resolve_attacks(self, now: float) -> None:
        attack_rect = self.player.attack_rect(now)
        if attack_rect is None:
            return
        for obstacle in self.obstacles:
            if (
                obstacle.alive
                and obstacle.destructible
                and attack_rect.colliderect(obstacle.rect)
            ):
                obstacle.alive = False
                self._reward(obstacle.score_value, sound=None)
                self.audio.play("destroy")
                self._flash(f"破壊 +{obstacle.score_value}", now)

    def _resolve_player_collisions(self, now: float) -> None:
        player_rect = self.player.collision_rect
        for obstacle in self.obstacles:
            if not obstacle.alive or not player_rect.colliderect(obstacle.rect):
                continue
            obstacle.alive = False
            obstacle.collided = True
            if self.player.has_shield(now):
                self.player.consume_shield(now)
                self._reward(100, sound=None)
                self.audio.play("shield_block")
                self._flash("シールド防御 +100", now)
            elif self.player.take_damage(now):
                self.combo = 0
                if self.player.lives > 0:
                    self.audio.play("hit")
                self._flash("ダメージ！ ライフ -1", now)

    def _resolve_coin_collisions(self, now: float) -> None:
        player_rect = self.player.collision_rect
        for coin in self.coins:
            if coin.alive and player_rect.colliderect(coin.rect):
                coin.alive = False
                value = 100 if self.player.is_boosting(now) else 50
                self._reward(value, combo=False, sound="score")

    def _resolve_passed_obstacles(self) -> None:
        for obstacle in self.obstacles:
            if (
                obstacle.alive
                and not obstacle.passed
                and obstacle.rect.right < self.player.rect.left
            ):
                obstacle.passed = True
                self._reward(100, sound="score")

    def _reward(
        self,
        base_points: int,
        combo: bool = True,
        sound: str | None = "score",
    ) -> None:
        if combo:
            self.combo += 1
            self.best_combo = max(self.best_combo, self.combo)
        multiplier = 1.0 + min(self.combo, 10) * 0.10
        self.score += base_points * multiplier
        if sound is not None:
            self.audio.play(sound)

    def _apply_decision(
        self,
        decision: ActionDecision | None,
        now: float,
    ) -> None:
        if decision is None:
            return
        succeeded = True
        if decision.action == GameAction.JUMP:
            succeeded = self.player.jump()
        elif decision.action == GameAction.BOOST:
            self.player.activate_boost(now)
        elif decision.action == GameAction.ATTACK:
            self.player.attack(now)
        elif decision.action == GameAction.SHIELD:
            self.player.activate_shield(now)

        action_name = ACTION_PRESENTATION[decision.action][2]
        source = "キーボード"
        if succeeded:
            self.audio.play(decision.action.value)
            self._flash(f"{action_name}  [{source}]", now)
        else:
            self.audio.play("error")
            self._flash("空中では再ジャンプできません", now)

    def _advance_face_action(self, now: float) -> None:
        """Finish the current cycle, then start the latest requested action."""

        current = self.player.face_action
        if current is not None:
            if not self.player.face_action_is_complete(now):
                return
            self.player.finish_face_action()

        # A keyboard-triggered jump also owns the character until landing.
        if not self.player.on_ground:
            return

        desired = self.controller.held_action
        if desired is None or not self.player.start_face_action(desired, now):
            return

        action_name = ACTION_PRESENTATION[desired][2]
        self.audio.play(desired.value)
        self._flash(f"{action_name}［表情］", now)

    def _flash(self, message: str, now: float) -> None:
        self.last_action_text = message
        self.last_action_until = now + settings.ACTION_TIP_DURATION

    def _draw(self, now: float) -> None:
        self.screen.blit(self.sky, (0, 0))
        self._draw_parallax()
        self._draw_ground()
        for coin_index, coin in enumerate(self.coins):
            phase = math.sin(now * 7.0 + coin_index * 0.8)
            coin.draw(self.screen, phase)
        for obstacle in self.obstacles:
            if obstacle.alive:
                obstacle.draw(self.screen)
        self.player.draw(self.screen, now)
        self._draw_hud(now)
        self._draw_camera_panel()
        self._draw_skill_bar(now)

        if now < self.last_action_until and self.state == GameState.PLAYING:
            self._draw_action_tip(self.last_action_text, settings.YELLOW)
        if self.state == GameState.MENU:
            self._draw_menu()
        elif self.state == GameState.PAUSED:
            self._draw_overlay("一時停止", "Pキーでゲームを再開")
        elif self.state == GameState.GAME_OVER:
            self._draw_game_over()

    def _draw_hud(self, now: float) -> None:
        hud_x = settings.HUD_X
        hud_y = settings.HUD_Y
        panel = pygame.Surface(
            (settings.HUD_WIDTH, settings.HUD_HEIGHT),
            pygame.SRCALPHA,
        )
        pygame.draw.rect(panel, (*settings.PANEL, 225), panel.get_rect(), border_radius=18)
        self.screen.blit(panel, (hud_x, hud_y))
        # 左・中央・右の各内容ブロックをHUD内で垂直中央に揃える。 / 将左、中、右三个内容区在HUD内垂直居中。
        self._text(
            f"スコア  {int(self.score):06d}",
            self.font_medium,
            settings.WHITE,
            (hud_x + 22, hud_y + 22),
        )
        self._text(
            f"ハイスコア  {self.high_score:06d}",
            self.font_small,
            settings.MUTED,
            (hud_x + 24, hud_y + 62),
        )
        self._text(
            f"コンボ  x{self.combo}",
            self.font_body,
            settings.YELLOW,
            (hud_x + 294, hud_y + 23),
        )
        self._text(
            f"スピード  {self.current_speed / 100:.1f}",
            self.font_body,
            settings.CYAN,
            (hud_x + 294, hud_y + 55),
        )
        self._text(
            f"プレイ時間 {self._format_elapsed_time(self.elapsed)}",
            self.font_small,
            settings.MUTED,
            (
                hud_x + settings.HUD_TIME_CENTER_X_OFFSET,
                hud_y + settings.HUD_TIME_CENTER_Y_OFFSET,
            ),
            center=True,
        )

        for index in range(settings.INITIAL_LIVES):
            color = settings.RED if index < self.player.lives else settings.PANEL_LIGHT
            self._draw_heart((hud_x + 512 + index * 34, hud_y + 49), color)
        if self.state == GameState.PLAYING:
            self._text(
                "P 一時停止  M ミュート",
                self.font_small,
                settings.MUTED,
                (hud_x + 482, hud_y + 68),
            )

    def _draw_camera_panel(self) -> None:
        x = settings.CAMERA_PANEL_X
        y = settings.CAMERA_PANEL_Y
        width = settings.CAMERA_PREVIEW_WIDTH
        height = settings.CAMERA_PREVIEW_HEIGHT
        outer = pygame.Rect(x - 7, y - 7, width + 14, height + 82)
        pygame.draw.rect(self.screen, settings.PANEL, outer, border_radius=14)
        pygame.draw.rect(self.screen, settings.CYAN, outer, 2, border_radius=14)

        if self.snapshot.status == "running" and self.snapshot.rgb_frame is not None:
            frame = self.snapshot.rgb_frame
            camera_surface = pygame.surfarray.make_surface(
                np.transpose(frame, (1, 0, 2))
            )
            self.screen.blit(camera_surface, (x, y))
        else:
            pygame.draw.rect(
                self.screen,
                settings.PANEL_LIGHT,
                (x, y, width, height),
                border_radius=8,
            )
            status_labels = {
                "starting": "カメラを準備中…",
                "loading_models": "AIモデルを読込中…",
                "opening_camera": "MacBookカメラを起動中…",
                "reconnecting": "カメラを再接続中…",
                "disabled": "カメラは無効です",
                "error": "カメラエラー",
            }
            label = status_labels.get(self.snapshot.status, self.snapshot.status)
            self._text(
                label,
                self.font_body,
                settings.MUTED,
                (x + width // 2, y + height // 2),
                center=True,
            )

        label_y = y + height + 8
        if self.snapshot.status == "running" and not self.snapshot.uncertain:
            emotion = self.snapshot.emotion or "--"
            emotion_text = EMOTION_JA.get(emotion, emotion)
            self._text(
                f"表情：{emotion_text}  {self.snapshot.confidence:.0%}",
                self.font_body,
                settings.GREEN,
                (x + 4, label_y),
            )
        elif self.snapshot.status == "running":
            candidate = self.snapshot.candidate or "--"
            candidate_text = EMOTION_JA.get(candidate, candidate)
            self._text("判定不能", self.font_body, settings.YELLOW, (x + 4, label_y))
            self._text(
                f"候補 {candidate_text} {self.snapshot.confidence:.0%}",
                self.font_small,
                settings.MUTED,
                (x + 116, label_y + 5),
            )
        else:
            self._text(
                "判定不能・キーボード操作可",
                self.font_small,
                settings.YELLOW,
                (x + 4, label_y + 5),
            )

        detail = (
            f"AI {self.snapshot.ai_fps:.1f} FPS・顔 {self.snapshot.face_count}"
            if self.snapshot.status == "running"
            else (self.snapshot.error or "カメラ待機中")
        )
        detail = self._ellipsize(detail, self.font_small, width - 8)
        self._text(detail, self.font_small, settings.MUTED, (x + 4, label_y + 34))

    def _draw_skill_bar(self, now: float) -> None:
        card_width = 195
        gap = 12
        total_width = card_width * 4 + gap * 3
        start_x = (settings.WINDOW_WIDTH - total_width) // 2
        y = 635
        for index, action in enumerate(GameAction):
            key, emotion, label, color = ACTION_PRESENTATION[action]
            x = start_x + index * (card_width + gap)
            rect = pygame.Rect(x, y, card_width, 68)
            is_active = self.player.face_action == action
            is_pending = (
                self.controller.held_action == action and not is_active
            )
            pygame.draw.rect(self.screen, settings.PANEL, rect, border_radius=12)
            if is_active or is_pending:
                active_fill = pygame.Surface(rect.size, pygame.SRCALPHA)
                pygame.draw.rect(
                    active_fill,
                    (*(color if is_active else settings.YELLOW), 45),
                    active_fill.get_rect(),
                    border_radius=12,
                )
                self.screen.blit(active_fill, rect.topleft)
            pygame.draw.rect(
                self.screen,
                settings.YELLOW if is_pending else color,
                rect,
                4 if is_active else (3 if is_pending else 2),
                border_radius=12,
            )
            self._text(key, self.font_small, color, (x + 13, y + 15))
            text_x_offset = (
                settings.SKILL_CARD_SPACE_TEXT_X_OFFSET
                if action == GameAction.JUMP
                else settings.SKILL_CARD_SHORT_KEY_TEXT_X_OFFSET
            )
            self._text(label, self.font_body, settings.WHITE, (x + text_x_offset, y + 8))
            if is_active:
                subtext = f"{emotion}・実行中"
                subcolor = settings.GREEN
            elif is_pending:
                subtext = f"{emotion}・次の動作"
                subcolor = settings.YELLOW
            else:
                subtext = emotion
                subcolor = settings.MUTED
            self._text(subtext, self.font_small, subcolor, (x + text_x_offset, y + 38))

            remaining = self.controller.cooldown_remaining(action, now)
            if remaining > 0.0 and not is_active and not is_pending:
                fraction = min(1.0, remaining / max(0.01, self._cooldown(action)))
                mask = pygame.Surface(rect.size, pygame.SRCALPHA)
                pygame.draw.rect(mask, (4, 8, 15, 165), mask.get_rect(), border_radius=12)
                self.screen.blit(mask, rect.topleft)
                self._text(
                    f"{remaining:.1f}s",
                    self.font_body,
                    settings.WHITE,
                    rect.center,
                    center=True,
                )
                pygame.draw.rect(
                    self.screen,
                    color,
                    (x + 4, rect.bottom - 6, int((card_width - 8) * (1 - fraction)), 3),
                    border_radius=2,
                )

    @staticmethod
    def _cooldown(action: GameAction) -> float:
        return {
            GameAction.JUMP: settings.JUMP_COOLDOWN,
            GameAction.BOOST: settings.BOOST_COOLDOWN,
            GameAction.ATTACK: settings.ATTACK_COOLDOWN,
            GameAction.SHIELD: settings.SHIELD_COOLDOWN,
        }[action]

    def _draw_menu(self) -> None:
        shade = pygame.Surface(self.screen.get_size(), pygame.SRCALPHA)
        shade.fill((6, 11, 22, 190))
        self.screen.blit(shade, (0, 0))
        self._text("EMOTION RUNNER", self.font_menu_title, settings.CYAN, (610, 202), center=True)
        self._text("表情ランナー", self.font_large, settings.WHITE, (640, 275), center=True)
        self._text(
            "表情で操作：喜び＝ジャンプ・驚き＝ブースト・怒り＝攻撃・悲しみ＝シールド",
            self.font_body,
            settings.WHITE,
            (640, 346),
            center=True,
        )
        self._text(
            "現在の動作が終わると、最新の表情に対応する動作へ切り替わります",
            self.font_small,
            settings.MUTED,
            (640, 384),
            center=True,
        )
        pygame.draw.rect(
            self.screen,
            settings.CYAN,
            self.start_button_rect,
            border_radius=18,
        )
        self._text(
            "ENTER / SPACE  スタート",
            self.font_medium,
            settings.PANEL,
            self.start_button_rect.center,
            center=True,
        )
        pygame.draw.rect(
            self.screen,
            settings.PANEL_LIGHT,
            self.volume_down_rect,
            border_radius=12,
        )
        pygame.draw.rect(
            self.screen,
            settings.CYAN,
            self.volume_down_rect,
            2,
            border_radius=12,
        )
        pygame.draw.rect(
            self.screen,
            settings.PANEL_LIGHT,
            self.volume_up_rect,
            border_radius=12,
        )
        pygame.draw.rect(
            self.screen,
            settings.CYAN,
            self.volume_up_rect,
            2,
            border_radius=12,
        )
        self._text(
            "－",
            self.font_medium,
            settings.WHITE,
            self.volume_down_rect.center,
            center=True,
        )
        self._text(
            "＋",
            self.font_medium,
            settings.WHITE,
            self.volume_up_rect.center,
            center=True,
        )
        volume_text = (
            "音量  ミュート"
            if self.audio.muted
            else f"音量  {self.audio.volume_percent}%"
        )
        self._text(
            volume_text,
            self.font_body,
            settings.WHITE,
            (640, 533),
            center=True,
        )
        self._text(
            "SPACE ジャンプ  S ブースト  A 攻撃  D シールド  P 一時停止  M ミュート  ESC 終了",
            self.font_small,
            settings.WHITE,
            (640, 587),
            center=True,
        )
        # Keep the camera calibration preview readable on the start screen.
        self._draw_camera_panel()

    def _draw_overlay(self, title: str, subtitle: str) -> None:
        shade = pygame.Surface(self.screen.get_size(), pygame.SRCALPHA)
        shade.fill((5, 9, 18, 185))
        self.screen.blit(shade, (0, 0))
        self._text(title, self.font_title, settings.WHITE, (640, 306), center=True)
        self._text(subtitle, self.font_medium, settings.CYAN, (640, 398), center=True)

    def _draw_game_over(self) -> None:
        shade = pygame.Surface(self.screen.get_size(), pygame.SRCALPHA)
        shade.fill((8, 8, 18, 212))
        self.screen.blit(shade, (0, 0))
        self._text("ゲームオーバー", self.font_title, settings.RED, (640, 210), center=True)
        self._text(f"今回のスコア  {int(self.score)}", self.font_large, settings.WHITE, (640, 310), center=True)
        self._text(f"ハイスコア  {self.high_score}     ベストCombo  x{self.best_combo}", self.font_body, settings.YELLOW, (640, 374), center=True)
        pygame.draw.rect(
            self.screen,
            settings.CYAN,
            self.restart_button_rect,
            border_radius=16,
        )
        self._text(
            "R / ENTER  リスタート",
            self.font_medium,
            settings.PANEL,
            self.restart_button_rect.center,
            center=True,
        )
        self._text("ESC 終了", self.font_small, settings.MUTED, (640, 528), center=True)

    def _draw_action_tip(self, text: str, color: tuple[int, int, int]) -> None:
        fitted_text = self._ellipsize(
            text,
            self.font_medium,
            settings.ACTION_TIP_WIDTH - 36,
        )
        rendered = self.font_medium.render(fitted_text, True, color)
        background = pygame.Surface(
            (settings.ACTION_TIP_WIDTH, settings.ACTION_TIP_HEIGHT),
            pygame.SRCALPHA,
        )
        pygame.draw.rect(
            background,
            (*settings.PANEL, settings.ACTION_TIP_BACKGROUND_ALPHA),
            background.get_rect(),
            border_radius=12,
        )
        background.blit(rendered, rendered.get_rect(center=background.get_rect().center))
        self.screen.blit(
            background,
            background.get_rect(
                center=(settings.ACTION_TIP_CENTER_X, settings.ACTION_TIP_CENTER_Y)
            ),
        )

    def _draw_parallax(self) -> None:
        offset = int(self.distance * 0.12) % 210
        for index in range(-1, 8):
            x = index * 210 - offset
            height = 70 + (index * 37 % 115)
            rect = pygame.Rect(x, settings.GROUND_Y - 130 - height, 145, height)
            pygame.draw.rect(self.screen, (38, 61, 89), rect, border_radius=7)
            for row in range(rect.top + 18, rect.bottom - 12, 24):
                for col in range(rect.left + 16, rect.right - 12, 27):
                    pygame.draw.rect(self.screen, (100, 135, 153), (col, row, 9, 7), border_radius=2)

    def _draw_ground(self) -> None:
        pygame.draw.rect(
            self.screen,
            settings.GROUND_COLOR,
            (0, settings.GROUND_Y, settings.WINDOW_WIDTH, settings.WINDOW_HEIGHT - settings.GROUND_Y),
        )
        pygame.draw.line(self.screen, settings.GROUND_LINE, (0, settings.GROUND_Y), (settings.WINDOW_WIDTH, settings.GROUND_Y), 4)
        dash_offset = int(self.distance) % 80
        for x in range(-80, settings.WINDOW_WIDTH + 80, 80):
            pygame.draw.line(self.screen, (68, 77, 89), (x - dash_offset, 626), (x + 42 - dash_offset, 626), 4)

    def _create_sky(self) -> pygame.Surface:
        surface = pygame.Surface((settings.WINDOW_WIDTH, settings.WINDOW_HEIGHT))
        for y in range(settings.WINDOW_HEIGHT):
            ratio = y / settings.WINDOW_HEIGHT
            color = tuple(
                int(top + (bottom - top) * ratio)
                for top, bottom in zip(settings.SKY_TOP, settings.SKY_BOTTOM)
            )
            pygame.draw.line(surface, color, (0, y), (settings.WINDOW_WIDTH, y))
        return surface

    def _draw_heart(self, center: tuple[int, int], color: tuple[int, int, int]) -> None:
        x, y = center
        pygame.draw.circle(self.screen, color, (x - 6, y - 4), 7)
        pygame.draw.circle(self.screen, color, (x + 6, y - 4), 7)
        pygame.draw.polygon(self.screen, color, ((x - 13, y - 2), (x + 13, y - 2), (x, y + 15)))

    def _text(
        self,
        text: str,
        font: pygame.font.Font,
        color: tuple[int, int, int],
        position: tuple[int, int],
        center: bool = False,
    ) -> None:
        rendered = font.render(text, True, color)
        rect = rendered.get_rect(center=position) if center else rendered.get_rect(topleft=position)
        self.screen.blit(rendered, rect)

    @staticmethod
    def _ellipsize(text: str, font: pygame.font.Font, max_width: int) -> str:
        if font.size(text)[0] <= max_width:
            return text
        shortened = text
        while shortened and font.size(shortened + "…")[0] > max_width:
            shortened = shortened[:-1]
        return shortened + "…"

    @staticmethod
    def _format_elapsed_time(seconds: float) -> str:
        rounded_seconds = round(max(0.0, seconds), 2)
        if rounded_seconds < 60.0:
            return f"{rounded_seconds:05.2f}秒"
        minutes, remaining_seconds = divmod(int(rounded_seconds), 60)
        return f"{minutes}分{remaining_seconds:02d}秒"

    @staticmethod
    def _load_font(size: int) -> pygame.font.Font:
        for path_text in settings.FONT_CANDIDATES:
            path = Path(path_text)
            if path.exists():
                try:
                    return pygame.font.Font(str(path), size)
                except pygame.error:
                    continue
        return pygame.font.Font(None, size)

    @staticmethod
    def _load_high_score() -> int:
        app_paths.migrate_legacy_high_score()
        try:
            data = json.loads(
                app_paths.high_score_path().read_text(encoding="utf-8")
            )
            return max(0, int(data.get("high_score", 0)))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return 0

    @staticmethod
    def _save_high_score(high_score: int) -> None:
        path = app_paths.high_score_path()
        temporary_path = path.with_suffix(".tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path.write_text(
                json.dumps(
                    {"high_score": int(high_score)},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            temporary_path.replace(path)
        except OSError:
            # A read-only or unavailable user directory must not end the game.
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
