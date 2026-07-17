"""Player physics, abilities, and procedural rendering."""

from __future__ import annotations

import math

import pygame

from . import settings
from .action_controller import GameAction


class Player:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.x = float(settings.PLAYER_START_X)
        self.y = float(settings.GROUND_Y - settings.PLAYER_HEIGHT)
        self.velocity_y = 0.0
        self.on_ground = True
        self.boost_until = 0.0
        self.attack_until = 0.0
        self.shield_until = 0.0
        self.face_action: GameAction | None = None
        self.face_action_until = 0.0
        self.invulnerable_until = 0.0
        self.lives = settings.INITIAL_LIVES
        self.run_phase = 0.0

    @property
    def rect(self) -> pygame.Rect:
        return pygame.Rect(
            round(self.x),
            round(self.y),
            settings.PLAYER_WIDTH,
            settings.PLAYER_HEIGHT,
        )

    @property
    def collision_rect(self) -> pygame.Rect:
        return self.rect.inflate(-16, -8)

    def jump(self) -> bool:
        if not self.on_ground:
            return False
        self.velocity_y = settings.JUMP_VELOCITY
        self.on_ground = False
        return True

    def activate_boost(self, now: float) -> None:
        self.boost_until = max(self.boost_until, now + settings.BOOST_DURATION)

    def attack(self, now: float) -> None:
        self.attack_until = max(self.attack_until, now + settings.ATTACK_DURATION)

    def activate_shield(self, now: float) -> None:
        self.shield_until = max(self.shield_until, now + settings.SHIELD_DURATION)

    def is_boosting(self, now: float) -> bool:
        face_boost = (
            self.face_action == GameAction.BOOST
            and now < self.face_action_until
        )
        return face_boost or now < self.boost_until

    def is_attacking(self, now: float) -> bool:
        face_attack = (
            self.face_action == GameAction.ATTACK
            and now < self.face_action_until
        )
        return face_attack or now < self.attack_until

    def has_shield(self, now: float) -> bool:
        face_shield = (
            self.face_action == GameAction.SHIELD
            and now < self.face_action_until
        )
        return face_shield or now < self.shield_until

    def start_face_action(self, action: GameAction, now: float) -> bool:
        """Start one complete facial-action cycle without interrupting another."""

        if self.face_action is not None:
            return False
        if action == GameAction.JUMP:
            if not self.jump():
                return False
            duration = 0.0
        elif action == GameAction.BOOST:
            duration = settings.BOOST_DURATION
        elif action == GameAction.ATTACK:
            duration = settings.ATTACK_DURATION
        else:
            duration = settings.SHIELD_DURATION
        self.face_action = action
        self.face_action_until = now + duration
        return True

    def face_action_is_complete(self, now: float) -> bool:
        if self.face_action is None:
            return True
        if self.face_action == GameAction.JUMP:
            return self.on_ground
        return now >= self.face_action_until

    def finish_face_action(self) -> None:
        self.face_action = None
        self.face_action_until = 0.0

    def attack_rect(self, now: float) -> pygame.Rect | None:
        if not self.is_attacking(now):
            return None
        player_rect = self.rect
        return pygame.Rect(player_rect.right - 2, player_rect.y + 18, 118, 54)

    def consume_shield(self, now: float) -> None:
        self.shield_until = now
        if self.face_action == GameAction.SHIELD:
            self.face_action_until = now

    def take_damage(self, now: float) -> bool:
        if now < self.invulnerable_until:
            return False
        self.lives = max(0, self.lives - 1)
        self.invulnerable_until = now + settings.PLAYER_INVULNERABILITY
        return True

    def update(self, delta_time: float, now: float) -> None:
        self.run_phase += delta_time * (13.0 if self.is_boosting(now) else 8.0)
        if not self.on_ground:
            self.velocity_y += settings.GRAVITY * delta_time
            self.y += self.velocity_y * delta_time
            ground_top = settings.GROUND_Y - settings.PLAYER_HEIGHT
            if self.y >= ground_top:
                self.y = float(ground_top)
                self.velocity_y = 0.0
                self.on_ground = True

    def draw(self, surface: pygame.Surface, now: float) -> None:
        rect = self.rect
        flashing = now < self.invulnerable_until and int(now * 12) % 2 == 0
        if flashing:
            return

        if self.has_shield(now):
            shield_surface = pygame.Surface((128, 128), pygame.SRCALPHA)
            pulse = 5 + int(3 * math.sin(now * 8))
            pygame.draw.circle(
                shield_surface,
                (*settings.CYAN, 46),
                (64, 64),
                52 + pulse,
            )
            pygame.draw.circle(
                shield_surface,
                (*settings.CYAN, 190),
                (64, 64),
                52 + pulse,
                3,
            )
            surface.blit(shield_surface, (rect.centerx - 64, rect.centery - 64))

        body_color = settings.YELLOW if self.is_boosting(now) else settings.CYAN
        skin = (255, 208, 170)
        # Head and body.
        pygame.draw.circle(surface, skin, (rect.centerx + 4, rect.y + 17), 15)
        pygame.draw.line(
            surface,
            body_color,
            (rect.centerx, rect.y + 34),
            (rect.centerx - 2, rect.y + 67),
            10,
        )
        # Animated arms and legs.
        swing = int(math.sin(self.run_phase) * 15) if self.on_ground else 6
        pygame.draw.line(
            surface,
            skin,
            (rect.centerx, rect.y + 42),
            (rect.centerx + 21, rect.y + 50 + swing // 3),
            6,
        )
        pygame.draw.line(
            surface,
            skin,
            (rect.centerx - 1, rect.y + 43),
            (rect.centerx - 20, rect.y + 54 - swing // 3),
            6,
        )
        pygame.draw.line(
            surface,
            body_color,
            (rect.centerx - 2, rect.y + 65),
            (rect.centerx + swing, rect.bottom - 2),
            8,
        )
        pygame.draw.line(
            surface,
            body_color,
            (rect.centerx - 2, rect.y + 65),
            (rect.centerx - swing, rect.bottom - 2),
            8,
        )

        if self.is_boosting(now):
            for index in range(3):
                y = rect.y + 46 + index * 11
                pygame.draw.line(
                    surface,
                    settings.YELLOW,
                    (rect.x - 16 - index * 12, y),
                    (rect.x - 2, y),
                    3,
                )

        attack_rect = self.attack_rect(now)
        if attack_rect is not None:
            wave = pygame.Surface(attack_rect.size, pygame.SRCALPHA)
            pygame.draw.ellipse(wave, (*settings.ORANGE, 90), wave.get_rect())
            pygame.draw.arc(
                wave,
                settings.YELLOW,
                wave.get_rect().inflate(-8, -8),
                -1.2,
                1.2,
                5,
            )
            surface.blit(wave, attack_rect.topleft)
