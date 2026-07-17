"""Command-line entry point for Emotion Runner."""

from __future__ import annotations

import argparse
import os
from typing import Sequence

from . import settings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Emotion Runner：表情またはキーボードで操作するランゲーム。"
    )
    parser.add_argument(
        "--camera",
        type=int,
        default=settings.CAMERA_INDEX,
        help="カメラindexを指定。省略時はMacBook内蔵カメラを名前で選択。",
    )
    parser.add_argument(
        "--no-camera",
        action="store_true",
        help="カメラを起動せず、Space / S / A / Dのみで操作。",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="障害物の乱数シードを固定して再現可能にする。",
    )
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help="画面を表示せず短い自動テストを実行して終了。",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.smoke_test:
        os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
        os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

    # Import after the dummy-driver variables have been applied.
    import pygame

    from .camera_worker import CameraWorker, NoCameraProvider
    from .game import EmotionRunnerGame

    camera = (
        NoCameraProvider()
        if args.no_camera or args.smoke_test
        else CameraWorker(args.camera)
    )
    camera.start()
    game = None
    try:
        game = EmotionRunnerGame(camera=camera, seed=args.seed)
        if args.smoke_test:
            game.start_new_game()
        game.run(max_frames=120 if args.smoke_test else None)
    finally:
        if game is not None:
            game.audio.shutdown()
        camera.stop()
        pygame.quit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
