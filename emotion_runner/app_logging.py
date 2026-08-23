"""File logging for the macOS application and camera child process."""

from __future__ import annotations

import logging
from pathlib import Path

from .app_paths import log_dir


LOGGER_NAME = "emotion_runner"
LOG_FILENAME = "EmotionRunner.log"


def log_path() -> Path:
    return log_dir() / LOG_FILENAME


def configure_logging() -> logging.Logger:
    """Configure an append-only application log without breaking startup."""

    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.INFO)
    target = log_path()
    if any(
        isinstance(handler, logging.FileHandler)
        and Path(handler.baseFilename) == target
        for handler in logger.handlers
    ):
        return logger

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(target, encoding="utf-8")
    except OSError:
        if not logger.handlers:
            logger.addHandler(logging.NullHandler())
        return logger

    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(processName)s %(levelname)s %(name)s: %(message)s"
        )
    )
    logger.addHandler(handler)
    return logger
