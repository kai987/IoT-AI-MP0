"""Isolated camera and emotion-recognition process for the game."""

from __future__ import annotations

from dataclasses import dataclass, replace
import logging
import multiprocessing as mp
import queue
import time

import numpy as np

from . import settings


CAMERA_READ_RETRY_ATTEMPTS = 12
CAMERA_READ_RETRY_DELAY = 0.05
CAMERA_RECONNECT_ATTEMPTS = 3
CAMERA_RECONNECT_DELAY = 0.40
CAMERA_HEARTBEAT_INTERVAL = 5.0


@dataclass(frozen=True)
class FeatureSnapshot:
    """Serializable subset of MediaPipe features used by game controls."""

    mouth_open_ratio: float
    jaw_open: float
    brow_raise: float
    brow_furrow: float
    smile: float
    eye_wide: float


@dataclass(frozen=True)
class CameraSnapshot:
    """Serializable copy of the latest camera inference result."""

    status: str = "starting"
    rgb_frame: np.ndarray | None = None
    emotion: str | None = None
    candidate: str | None = None
    confidence: float = 0.0
    uncertain: bool = True
    features: FeatureSnapshot | None = None
    face_count: int = 0
    ai_fps: float = 0.0
    camera_index: int | None = None
    resolution: tuple[int, int] | None = None
    error: str | None = None


def _queue_latest(
    output_queue: mp.Queue,
    snapshot: CameraSnapshot,
) -> None:
    """Publish without allowing a slow game window to block camera capture."""

    try:
        output_queue.put_nowait(snapshot)
        return
    except queue.Full:
        pass
    try:
        output_queue.get_nowait()
    except queue.Empty:
        pass
    try:
        output_queue.put_nowait(snapshot)
    except queue.Full:
        pass


def _read_frame_with_retries(
    capture,
    stop_event,
    attempts: int = CAMERA_READ_RETRY_ATTEMPTS,
    delay: float = CAMERA_READ_RETRY_DELAY,
) -> tuple[np.ndarray | None, int]:
    """Tolerate transient AVFoundation frame drops before reconnecting."""

    failures = 0
    for attempt in range(max(1, attempts)):
        if stop_event.is_set():
            return None, failures
        try:
            ok, frame = capture.read()
        except Exception:
            ok, frame = False, None
        if ok and frame is not None and getattr(frame, "size", 0) > 0:
            if stop_event.is_set():
                return None, failures
            return frame, failures
        failures += 1
        if attempt + 1 < max(1, attempts) and stop_event.wait(max(0.0, delay)):
            return None, failures
    return None, failures


def _reopen_camera_with_retries(
    open_index,
    camera_index: int,
    stop_event,
    attempts: int = CAMERA_RECONNECT_ATTEMPTS,
    delay: float = CAMERA_RECONNECT_DELAY,
):
    """Try to reacquire the same physical camera without switching devices."""

    completed_attempts = 0
    for attempt in range(max(1, attempts)):
        if stop_event.is_set():
            break
        completed_attempts += 1
        try:
            capture = open_index(camera_index)
        except Exception:
            capture = None
        if capture is not None:
            return capture, completed_attempts
        if attempt + 1 < max(1, attempts) and stop_event.wait(max(0.0, delay)):
            break
    return None, completed_attempts


def _camera_process(
    preferred_index: int | None,
    stop_event: mp.Event,
    output_queue: mp.Queue,
) -> None:
    """Child-process entry point; imports OpenCV outside the Pygame process."""

    from .app_logging import configure_logging

    logger = configure_logging()
    output_queue.cancel_join_thread()
    logger.info("Camera inference process started; preferred index=%s", preferred_index)

    app = None
    capture = None
    active_index: int | None = None
    frame_number = 0
    smoothed_fps = 0.0
    try:
        _queue_latest(output_queue, CameraSnapshot(status="loading_models"))
        dependency_started = time.perf_counter()
        import cv2

        from emotion_recognition import (
            CAMERA_FRAME_HEIGHT,
            CAMERA_FRAME_WIDTH,
            EMOTION_LABELS_EN,
            EmotionRecognitionApp,
            _open_camera_index,
            box_size,
            open_camera,
        )
        logger.info(
            "Camera AI dependencies loaded in %.3fs",
            time.perf_counter() - dependency_started,
        )

        def configure_capture(active_capture) -> tuple[int, int]:
            active_capture.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_FRAME_WIDTH)
            active_capture.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_FRAME_HEIGHT)
            return (
                int(active_capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
                int(active_capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            )

        model_started = time.perf_counter()
        app = EmotionRecognitionApp()
        logger.info(
            "Camera AI models initialized in %.3fs",
            time.perf_counter() - model_started,
        )
        if stop_event.is_set():
            return

        _queue_latest(output_queue, CameraSnapshot(status="opening_camera"))
        camera_started = time.perf_counter()
        capture, active_index = open_camera(preferred_index)
        width, height = configure_capture(capture)
        logger.info(
            "Camera ready: index=%s resolution=%sx%s open_time=%.3fs",
            active_index,
            width,
            height,
            time.perf_counter() - camera_started,
        )
        last_heartbeat = 0.0

        while not stop_event.is_set():
            started = time.perf_counter()
            frame, read_failures = _read_frame_with_retries(
                capture,
                stop_event,
            )
            if frame is None:
                if stop_event.is_set():
                    return
                logger.warning(
                    "Camera returned no valid frame %s consecutive times; "
                    "reconnecting index=%s",
                    read_failures,
                    active_index,
                )
                _queue_latest(
                    output_queue,
                    CameraSnapshot(
                        status="reconnecting",
                        camera_index=active_index,
                        resolution=(width, height),
                        error="カメラ映像を再接続しています…",
                    ),
                )
                try:
                    capture.release()
                except Exception:
                    logger.exception("Camera release failed before reconnect")
                capture = None
                capture, reconnect_attempts = _reopen_camera_with_retries(
                    _open_camera_index,
                    active_index,
                    stop_event,
                )
                if stop_event.is_set():
                    return
                if capture is None:
                    raise RuntimeError(
                        "カメラ映像を再取得できません。"
                        f"index={active_index} を{reconnect_attempts}回再接続しました。"
                        "カメラを使用中のアプリを閉じて、ゲームを再起動してください。"
                    )
                width, height = configure_capture(capture)
                logger.info(
                    "Camera reconnected: index=%s attempts=%s resolution=%sx%s",
                    active_index,
                    reconnect_attempts,
                    width,
                    height,
                )
                continue
            if read_failures:
                logger.info(
                    "Camera frame stream recovered after %s failed read(s)",
                    read_failures,
                )
            if stop_event.is_set():
                return

            frame = cv2.flip(frame, 1)
            annotated = app.process_frame(
                frame,
                frame_number=frame_number,
                fps=smoothed_fps or None,
            )
            frame_number += 1

            elapsed = max(1e-6, time.perf_counter() - started)
            instant_fps = 1.0 / elapsed
            smoothed_fps = (
                instant_fps
                if smoothed_fps <= 0.0
                else 0.15 * instant_fps + 0.85 * smoothed_fps
            )

            tracks = app.visible_tracks
            primary = max(tracks, key=lambda item: box_size(item.box), default=None)
            emotion: str | None = None
            candidate: str | None = None
            confidence = 0.0
            features = None
            uncertain = True
            if primary is not None:
                if primary.facial_features is not None:
                    values = primary.facial_features
                    features = FeatureSnapshot(
                        mouth_open_ratio=values.mouth_open_ratio,
                        jaw_open=values.jaw_open,
                        brow_raise=values.brow_raise,
                        brow_furrow=values.brow_furrow,
                        smile=values.smile,
                        eye_wide=values.eye_wide,
                    )
                if primary.emotion_index is not None:
                    emotion = EMOTION_LABELS_EN[primary.emotion_index]
                    confidence = primary.emotion_confidence
                    uncertain = False
                elif primary.top_index is not None:
                    candidate = EMOTION_LABELS_EN[primary.top_index]
                    confidence = primary.top_confidence

            heartbeat_now = time.monotonic()
            if heartbeat_now - last_heartbeat >= CAMERA_HEARTBEAT_INTERVAL:
                logger.info(
                    "Camera heartbeat: frame=%s ai_fps=%.1f faces=%s "
                    "emotion=%s candidate=%s confidence=%.3f",
                    frame_number,
                    smoothed_fps,
                    len(tracks),
                    emotion or "unknown",
                    candidate or emotion or "none",
                    confidence,
                )
                last_heartbeat = heartbeat_now

            preview = cv2.resize(
                annotated,
                (
                    settings.CAMERA_PREVIEW_WIDTH,
                    settings.CAMERA_PREVIEW_HEIGHT,
                ),
                interpolation=cv2.INTER_AREA,
            )
            preview = cv2.cvtColor(preview, cv2.COLOR_BGR2RGB)
            _queue_latest(
                output_queue,
                CameraSnapshot(
                    status="running",
                    rgb_frame=np.ascontiguousarray(preview),
                    emotion=emotion,
                    candidate=candidate,
                    confidence=confidence,
                    uncertain=uncertain,
                    features=features,
                    face_count=len(tracks),
                    ai_fps=smoothed_fps,
                    camera_index=active_index,
                    resolution=(width, height),
                ),
            )
    except Exception as error:  # Keep the keyboard-only game usable.
        logger.exception("Camera inference process failed")
        _queue_latest(
            output_queue,
            CameraSnapshot(
                status="error",
                camera_index=active_index,
                error=str(error),
            ),
        )
    finally:
        if capture is not None:
            try:
                capture.release()
            except Exception:
                logger.exception("Camera release failed during worker cleanup")
        if app is not None:
            try:
                app.close()
            except Exception:
                logger.exception("Model cleanup failed during worker shutdown")
        logger.info("Camera inference process stopped")


class CameraWorker:
    """Own the camera and AI models in a separate spawned process.

    Pygame only reads snapshots. A slow inference frame therefore never blocks
    the configured game loop, and OpenCV cannot conflict with Pygame's SDL.
    """

    def __init__(self, camera_index: int | None = None) -> None:
        self.camera_index = camera_index
        self._context = mp.get_context("spawn")
        self._stop_event = self._context.Event()
        self._queue = self._context.Queue(maxsize=2)
        self._process: mp.Process | None = None
        self._snapshot = CameraSnapshot()
        self._closed = False

    def start(self) -> None:
        if self._closed:
            raise RuntimeError("CameraWorker cannot be restarted after it is stopped")
        if self._process is not None and self._process.is_alive():
            return
        self._stop_event.clear()
        process = self._context.Process(
            target=_camera_process,
            args=(self.camera_index, self._stop_event, self._queue),
            name="emotion-runner-camera",
            daemon=True,
        )
        process.start()
        self._process = process

    def stop(self, timeout: float = 4.0) -> None:
        if self._closed:
            return
        self._stop_event.set()
        if self._process is not None:
            process = self._process
            process.join(timeout)
            if process.is_alive():
                process.terminate()
                process.join(1.0)
            if process.is_alive() and hasattr(process, "kill"):
                process.kill()
                process.join(1.0)
            if process.is_alive():
                logging.getLogger("emotion_runner").critical(
                    "Camera inference process is still alive after kill()"
                )
            else:
                process.close()
                self._process = None
        self._queue.close()
        self._queue.cancel_join_thread()
        self._closed = True

    def latest(self) -> CameraSnapshot:
        while True:
            try:
                self._snapshot = self._queue.get_nowait()
            except queue.Empty:
                break
        if (
            self._process is not None
            and not self._process.is_alive()
            and self._snapshot.status not in ("error", "disabled")
        ):
            self._snapshot = replace(
                self._snapshot,
                status="error",
                rgb_frame=None,
                emotion=None,
                candidate=None,
                confidence=0.0,
                uncertain=True,
                features=None,
                face_count=0,
                ai_fps=0.0,
                error="カメラ認識プロセスが停止しました。キーボード操作は使用できます。",
            )
        return replace(self._snapshot)


class NoCameraProvider:
    """Camera provider used for keyboard-only play and automated smoke tests."""

    def start(self) -> None:
        return None

    def stop(self, timeout: float = 0.0) -> None:
        return None

    def latest(self) -> CameraSnapshot:
        return CameraSnapshot(
            status="disabled",
            error="カメラは無効です。キーボードで操作できます。",
        )
