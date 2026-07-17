"""Isolated camera and emotion-recognition process for the game."""

from __future__ import annotations

from dataclasses import dataclass, replace
import multiprocessing as mp
import queue
import time

import numpy as np

from . import settings


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


def _camera_process(
    preferred_index: int | None,
    stop_event: mp.Event,
    output_queue: mp.Queue,
) -> None:
    """Child-process entry point; imports OpenCV outside the Pygame process."""

    import cv2

    from emotion_recognition import (
        CAMERA_FRAME_HEIGHT,
        CAMERA_FRAME_WIDTH,
        EMOTION_LABELS_EN,
        EmotionRecognitionApp,
        box_size,
        open_camera,
    )

    app: EmotionRecognitionApp | None = None
    capture: cv2.VideoCapture | None = None
    active_index: int | None = None
    frame_number = 0
    smoothed_fps = 0.0
    try:
        _queue_latest(output_queue, CameraSnapshot(status="loading_models"))
        app = EmotionRecognitionApp()
        if stop_event.is_set():
            return

        _queue_latest(output_queue, CameraSnapshot(status="opening_camera"))
        capture, active_index = open_camera(preferred_index)
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_FRAME_WIDTH)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_FRAME_HEIGHT)
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))

        while not stop_event.is_set():
            started = time.perf_counter()
            ok, frame = capture.read()
            if not ok or frame is None:
                raise RuntimeError(
                    "カメラ映像を取得できません。"
                    "カメラを使用中のアプリを閉じて、再実行してください。"
                )

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
            capture.release()
        if app is not None:
            app.close()


class CameraWorker:
    """Own the camera and AI models in a separate spawned process.

    Pygame only reads snapshots. A slow inference frame therefore never blocks
    the 60 FPS window event loop, and OpenCV cannot conflict with Pygame's SDL.
    """

    def __init__(self, camera_index: int | None = None) -> None:
        self.camera_index = camera_index
        self._context = mp.get_context("spawn")
        self._stop_event = self._context.Event()
        self._queue = self._context.Queue(maxsize=2)
        self._process: mp.Process | None = None
        self._snapshot = CameraSnapshot()

    def start(self) -> None:
        if self._process is not None and self._process.is_alive():
            return
        self._stop_event.clear()
        self._process = self._context.Process(
            target=_camera_process,
            args=(self.camera_index, self._stop_event, self._queue),
            name="emotion-runner-camera",
            daemon=True,
        )
        self._process.start()

    def stop(self, timeout: float = 4.0) -> None:
        self._stop_event.set()
        if self._process is not None:
            self._process.join(timeout)
            if self._process.is_alive():
                self._process.terminate()
                self._process.join(1.0)

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
