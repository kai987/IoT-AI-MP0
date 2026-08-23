"""PyInstaller-safe entry point for the Emotion Runner macOS app."""

from __future__ import annotations

import multiprocessing


# This must run before importing modules that pull in Pygame, OpenCV, or
# MediaPipe. PyInstaller redirects spawned worker invocations here.
multiprocessing.freeze_support()


def run() -> int:
    import logging
    import platform
    import sys

    from emotion_runner.app_logging import configure_logging
    from emotion_runner.app_paths import (
        REQUIRED_MODEL_FILENAMES,
        is_frozen,
        model_path,
    )

    logger = configure_logging()
    logger.info("Application start")
    logger.info("Python version: %s", sys.version.replace("\n", " "))
    logger.info("CPU architecture: %s", platform.machine())
    logger.info("Frozen environment: %s", is_frozen())
    for filename in REQUIRED_MODEL_FILENAMES:
        logger.info("Model resource: %s", model_path(filename))

    try:
        # Import only after freeze_support and runtime logging are ready.
        from emotion_runner.main import main

        return main()
    except Exception:
        logger.exception("Unhandled application exception")
        raise
    finally:
        logging.shutdown()


if __name__ == "__main__":
    raise SystemExit(run())
