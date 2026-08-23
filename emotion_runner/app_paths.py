"""Runtime paths shared by source and frozen Emotion Runner builds.

This module intentionally depends only on the Python standard library so it
can be imported before Pygame, OpenCV, or MediaPipe in a frozen application.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import sys


APP_NAME = "Emotion Runner"
DATA_DIR_ENV = "EMOTION_RUNNER_DATA_DIR"

REQUIRED_MODEL_FILENAMES = (
    "face_detection_yunet_2023mar.onnx",
    "enet_b0_8_best_vgaf.onnx",
    "face_landmarker.task",
)


def is_frozen() -> bool:
    """Return whether this process is running from a PyInstaller bundle."""

    return bool(getattr(sys, "frozen", False))


def resource_root() -> Path:
    """Return the root containing bundled resources such as ``models``."""

    if is_frozen() and hasattr(sys, "_MEIPASS"):
        return Path(getattr(sys, "_MEIPASS")).resolve()
    return Path(__file__).resolve().parents[1]


def model_path(filename: str) -> Path:
    """Return an absolute path for a model or model-license resource."""

    return resource_root() / "models" / filename


def app_support_dir() -> Path:
    """Return the writable per-user application data directory."""

    override = os.environ.get(DATA_DIR_ENV)
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / APP_NAME


def log_dir() -> Path:
    """Return the per-user log directory used by source and frozen builds."""

    return Path.home() / "Library" / "Logs" / APP_NAME


def screenshot_dir() -> Path:
    """Return a writable screenshot directory for the current runtime."""

    if is_frozen():
        return Path.home() / "Pictures" / APP_NAME
    return resource_root()


def high_score_path() -> Path:
    """Return the writable high-score file path."""

    return app_support_dir() / "high_score.json"


def legacy_high_score_path() -> Path:
    """Return the old source-tree high-score location."""

    return resource_root() / "emotion_runner" / "data" / "high_score.json"


def migrate_legacy_high_score() -> bool:
    """Copy an old score file once, without making startup depend on it."""

    source = legacy_high_score_path()
    destination = high_score_path()
    if destination.exists() or not source.is_file():
        return False
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    except OSError:
        return False
    return True
