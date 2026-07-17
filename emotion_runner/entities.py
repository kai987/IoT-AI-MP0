"""Obstacles and collectible coins."""

from __future__ import annotations

from dataclasses import dataclass, field

import pygame

from . import settings


OBSTACLE_SPECS = {
    "rock": (54, 44, False, 100),
    "crate": (62, 62, True, 150),
    "enemy": (54, 80, True, 200),
    "barrier": (48, 128, False, 180),
}


@dataclass
class Obstacle:
    kind: str
    x: float
    ground_y: int = settings.GROUND_Y
    alive: bool = True
    passed: bool = False
    collided: bool = False
    width: int = field(init=False)
    height: int = field(init=False)
    destructible: bool = field(init=False)
    score_value: int = field(init=False)

    def __post_init__(self) -> None:
        if self.kind not in OBSTACLE_SPECS:
            raise ValueError(f"Unknown obstacle kind: {self.kind}")
        self.width, self.height, self.destructible, self.score_value = (
            OBSTACLE_SPECS[self.kind]
        )

    @property
    def rect(self) -> pygame.Rect:
        return pygame.Rect(
            round(self.x),
            self.ground_y - self.height,
            self.width,
            self.height,
        )

    def update(self, delta_time: float, speed: float) -> None:
        self.x -= speed * delta_time

    def is_offscreen(self) -> bool:
        return self.x + self.width < -20

    def draw(self, surface: pygame.Surface) -> None:
        rect = self.rect
        if self.kind == "rock":
            points = (
                (rect.left, rect.bottom),
                (rect.left + 7, rect.top + 12),
                (rect.centerx, rect.top),
                (rect.right - 3, rect.top + 15),
                (rect.right, rect.bottom),
            )
            pygame.draw.polygon(surface, (113, 125, 141), points)
            pygame.draw.line(surface, (171, 181, 194), points[1], points[2], 3)
        elif self.kind == "crate":
            pygame.draw.rect(surface, (164, 94, 45), rect, border_radius=5)
            pygame.draw.rect(surface, (237, 166, 80), rect, 4, border_radius=5)
            pygame.draw.line(surface, (237, 166, 80), rect.topleft, rect.bottomright, 5)
            pygame.draw.line(surface, (237, 166, 80), rect.topright, rect.bottomleft, 5)
        elif self.kind == "enemy":
            pygame.draw.rect(surface, settings.RED, rect, border_radius=14)
            pygame.draw.circle(surface, settings.WHITE, (rect.x + 16, rect.y + 24), 6)
            pygame.draw.circle(surface, settings.WHITE, (rect.right - 16, rect.y + 24), 6)
            pygame.draw.circle(surface, settings.PANEL, (rect.x + 16, rect.y + 24), 3)
            pygame.draw.circle(surface, settings.PANEL, (rect.right - 16, rect.y + 24), 3)
            pygame.draw.line(
                surface,
                settings.PANEL,
                (rect.x + 14, rect.bottom - 22),
                (rect.right - 14, rect.bottom - 22),
                4,
            )
        else:
            pygame.draw.rect(surface, settings.PURPLE, rect, border_radius=6)
            for y in range(rect.top + 10, rect.bottom, 20):
                pygame.draw.line(
                    surface,
                    settings.YELLOW,
                    (rect.left + 4, y),
                    (rect.right - 4, y + 12),
                    5,
                )


@dataclass
class Coin:
    x: float
    y: float
    radius: int = 12
    alive: bool = True

    @property
    def rect(self) -> pygame.Rect:
        return pygame.Rect(
            round(self.x - self.radius),
            round(self.y - self.radius),
            self.radius * 2,
            self.radius * 2,
        )

    def update(self, delta_time: float, speed: float) -> None:
        self.x -= speed * delta_time

    def is_offscreen(self) -> bool:
        return self.x + self.radius < -10

    def draw(self, surface: pygame.Surface, phase: float) -> None:
        visible_width = max(4, round(self.radius * (0.35 + 0.65 * abs(phase))))
        rect = pygame.Rect(0, 0, visible_width * 2, self.radius * 2)
        rect.center = (round(self.x), round(self.y))
        pygame.draw.ellipse(surface, settings.YELLOW, rect)
        pygame.draw.ellipse(surface, (255, 239, 148), rect, 3)

