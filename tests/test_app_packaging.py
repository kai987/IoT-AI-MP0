"""Tests for macOS packaging paths, camera fallback, and frozen entry safety."""

from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, call, patch

os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

import numpy as np

import emotion_recognition as recognition
from emotion_runner import app_paths, settings
from emotion_runner.camera_worker import (
    CameraSnapshot,
    CameraWorker,
    FeatureSnapshot,
    _read_frame_with_retries,
    _reopen_camera_with_retries,
)
from emotion_runner.game import EmotionRunnerGame
from emotion_runner import main as runner_main


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class AppPathTests(unittest.TestCase):
    def test_development_resource_root_is_repository_root(self) -> None:
        with patch.object(sys, "frozen", False, create=True):
            self.assertEqual(app_paths.resource_root(), PROJECT_ROOT)

    def test_frozen_resource_root_uses_meipass(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with (
                patch.object(sys, "frozen", True, create=True),
                patch.object(sys, "_MEIPASS", temporary, create=True),
            ):
                self.assertEqual(
                    app_paths.resource_root(),
                    Path(temporary).resolve(),
                )
                self.assertEqual(
                    app_paths.model_path("example.onnx"),
                    Path(temporary).resolve() / "models" / "example.onnx",
                )

    def test_data_directory_environment_override(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            expected = Path(temporary).resolve()
            with patch.dict(
                os.environ,
                {app_paths.DATA_DIR_ENV: temporary},
            ):
                self.assertEqual(app_paths.app_support_dir(), expected)
                self.assertEqual(
                    app_paths.high_score_path(),
                    expected / "high_score.json",
                )

    def test_required_model_list_is_exact(self) -> None:
        self.assertEqual(
            app_paths.REQUIRED_MODEL_FILENAMES,
            (
                "face_detection_yunet_2023mar.onnx",
                "enet_b0_8_best_vgaf.onnx",
                "face_landmarker.task",
            ),
        )
        self.assertNotIn(
            "emotion-ferplus-8.onnx",
            app_paths.REQUIRED_MODEL_FILENAMES,
        )


class HighScorePathTests(unittest.TestCase):
    def test_high_score_save_and_load_use_user_data_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(
                os.environ,
                {app_paths.DATA_DIR_ENV: temporary},
            ):
                EmotionRunnerGame._save_high_score(4321)
                self.assertEqual(EmotionRunnerGame._load_high_score(), 4321)
                data = json.loads(
                    (Path(temporary) / "high_score.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(data, {"high_score": 4321})

    def test_legacy_high_score_is_copied_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "resources"
            destination_dir = Path(temporary) / "user-data"
            legacy = root / "emotion_runner" / "data" / "high_score.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text('{"high_score": 9876}\n', encoding="utf-8")

            with (
                patch.object(app_paths, "resource_root", return_value=root),
                patch.dict(
                    os.environ,
                    {app_paths.DATA_DIR_ENV: str(destination_dir)},
                ),
            ):
                self.assertTrue(app_paths.migrate_legacy_high_score())
                self.assertFalse(app_paths.migrate_legacy_high_score())

            destination = destination_dir / "high_score.json"
            self.assertTrue(legacy.exists())
            self.assertEqual(
                json.loads(destination.read_text(encoding="utf-8")),
                {"high_score": 9876},
            )

    def test_migration_failure_does_not_block_startup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with (
                patch.dict(
                    os.environ,
                    {app_paths.DATA_DIR_ENV: temporary},
                ),
                patch.object(Path, "is_file", return_value=True),
                patch("emotion_runner.app_paths.shutil.copy2", side_effect=OSError),
            ):
                self.assertFalse(app_paths.migrate_legacy_high_score())


class FakeCapture:
    def __init__(
        self,
        opened: bool = True,
        reads: list[tuple[bool, np.ndarray | None]] | None = None,
        opened_error: Exception | None = None,
    ) -> None:
        self.opened = opened
        self.reads = list(reads or [])
        self.opened_error = opened_error
        self.release_count = 0

    def isOpened(self) -> bool:
        if self.opened_error is not None:
            raise self.opened_error
        return self.opened

    def read(self) -> tuple[bool, np.ndarray | None]:
        if self.reads:
            return self.reads.pop(0)
        return False, None

    def release(self) -> None:
        self.release_count += 1


class FakeStopEvent:
    def __init__(self) -> None:
        self.set_count = 0

    def set(self) -> None:
        self.set_count += 1


class FakeWorkerQueue:
    def __init__(self) -> None:
        self.close_count = 0
        self.cancel_count = 0

    def close(self) -> None:
        self.close_count += 1

    def cancel_join_thread(self) -> None:
        self.cancel_count += 1


class FakeWorkerProcess:
    def __init__(
        self,
        *,
        alive: bool,
        terminate_stops: bool = True,
        kill_stops: bool = True,
    ) -> None:
        self.alive = alive
        self.terminate_stops = terminate_stops
        self.kill_stops = kill_stops
        self.joins: list[float] = []
        self.terminate_count = 0
        self.kill_count = 0
        self.close_count = 0

    def join(self, timeout: float) -> None:
        self.joins.append(timeout)

    def is_alive(self) -> bool:
        return self.alive

    def terminate(self) -> None:
        self.terminate_count += 1
        if self.terminate_stops:
            self.alive = False

    def kill(self) -> None:
        self.kill_count += 1
        if self.kill_stops:
            self.alive = False

    def close(self) -> None:
        self.close_count += 1


class FakeRetryEvent:
    def __init__(self, stopped: bool = False) -> None:
        self.stopped = stopped
        self.waits: list[float] = []

    def is_set(self) -> bool:
        return self.stopped

    def wait(self, timeout: float) -> bool:
        self.waits.append(timeout)
        return self.stopped


class FakeStopDuringReadCapture:
    def __init__(self, stop_event: FakeRetryEvent, frame: np.ndarray) -> None:
        self.stop_event = stop_event
        self.frame = frame

    def read(self) -> tuple[bool, np.ndarray]:
        self.stop_event.stopped = True
        return True, self.frame


def make_worker_for_stop_test(
    process: FakeWorkerProcess,
) -> tuple[CameraWorker, FakeStopEvent, FakeWorkerQueue]:
    worker = object.__new__(CameraWorker)
    stop_event = FakeStopEvent()
    worker_queue = FakeWorkerQueue()
    worker._stop_event = stop_event
    worker._queue = worker_queue
    worker._process = process
    worker._closed = False
    return worker, stop_event, worker_queue


class CameraWorkerStopTests(unittest.TestCase):
    def test_graceful_stop_closes_process_and_is_idempotent(self) -> None:
        process = FakeWorkerProcess(alive=False)
        worker, stop_event, worker_queue = make_worker_for_stop_test(process)

        worker.stop(timeout=2.5)
        worker.stop(timeout=2.5)

        self.assertEqual(process.joins, [2.5])
        self.assertEqual(process.close_count, 1)
        self.assertEqual(stop_event.set_count, 1)
        self.assertEqual(worker_queue.close_count, 1)
        self.assertEqual(worker_queue.cancel_count, 1)
        self.assertIsNone(worker._process)

    def test_stop_terminates_a_process_that_ignores_the_event(self) -> None:
        process = FakeWorkerProcess(alive=True, terminate_stops=True)
        worker, _stop_event, _worker_queue = make_worker_for_stop_test(process)

        worker.stop(timeout=4.0)

        self.assertEqual(process.joins, [4.0, 1.0])
        self.assertEqual(process.terminate_count, 1)
        self.assertEqual(process.kill_count, 0)
        self.assertEqual(process.close_count, 1)
        self.assertIsNone(worker._process)

    def test_stop_kills_a_process_that_ignores_terminate(self) -> None:
        process = FakeWorkerProcess(
            alive=True,
            terminate_stops=False,
            kill_stops=True,
        )
        worker, _stop_event, _worker_queue = make_worker_for_stop_test(process)

        worker.stop(timeout=1.0)

        self.assertEqual(process.joins, [1.0, 1.0, 1.0])
        self.assertEqual(process.terminate_count, 1)
        self.assertEqual(process.kill_count, 1)
        self.assertEqual(process.close_count, 1)
        self.assertIsNone(worker._process)


class CameraStreamRecoveryTests(unittest.TestCase):
    def test_transient_frame_drop_recovers_without_reopening(self) -> None:
        frame = np.zeros((4, 4, 3), dtype=np.uint8)
        capture = FakeCapture(
            reads=[(False, None), (False, None), (True, frame)],
        )
        stop_event = FakeRetryEvent()

        result, failures = _read_frame_with_retries(
            capture,
            stop_event,
            attempts=4,
            delay=0.02,
        )

        self.assertIs(result, frame)
        self.assertEqual(failures, 2)
        self.assertEqual(stop_event.waits, [0.02, 0.02])

    def test_sustained_frame_drop_requests_reconnect(self) -> None:
        capture = FakeCapture(reads=[(False, None)] * 3)
        stop_event = FakeRetryEvent()

        result, failures = _read_frame_with_retries(
            capture,
            stop_event,
            attempts=3,
            delay=0.01,
        )

        self.assertIsNone(result)
        self.assertEqual(failures, 3)
        self.assertEqual(stop_event.waits, [0.01, 0.01])

    def test_stop_during_successful_read_discards_the_frame(self) -> None:
        stop_event = FakeRetryEvent()
        frame = np.zeros((4, 4, 3), dtype=np.uint8)
        capture = FakeStopDuringReadCapture(stop_event, frame)

        result, failures = _read_frame_with_retries(
            capture,
            stop_event,
            attempts=3,
            delay=0.01,
        )

        self.assertIsNone(result)
        self.assertEqual(failures, 0)

    def test_camera_reopen_retries_same_index_until_success(self) -> None:
        selected = object()
        opener = MagicMock(side_effect=[None, None, selected])
        stop_event = FakeRetryEvent()

        capture, attempts = _reopen_camera_with_retries(
            opener,
            2,
            stop_event,
            attempts=3,
            delay=0.05,
        )

        self.assertIs(capture, selected)
        self.assertEqual(attempts, 3)
        self.assertEqual(opener.call_args_list, [call(2), call(2), call(2)])
        self.assertEqual(stop_event.waits, [0.05, 0.05])


class CameraWorkerSnapshotTests(unittest.TestCase):
    def test_dead_process_clears_stale_frame_and_inference(self) -> None:
        worker = object.__new__(CameraWorker)
        worker._process = FakeWorkerProcess(alive=False)
        worker._queue = MagicMock()
        worker._queue.get_nowait.side_effect = queue.Empty
        worker._snapshot = CameraSnapshot(
            status="running",
            rgb_frame=np.zeros((4, 4, 3), dtype=np.uint8),
            emotion="happiness",
            candidate="happiness",
            confidence=0.88,
            uncertain=False,
            features=FeatureSnapshot(1.0, 1.0, 1.0, 1.0, 1.0, 1.0),
            face_count=1,
            ai_fps=12.0,
            camera_index=0,
            resolution=(1920, 1080),
        )

        snapshot = worker.latest()

        self.assertEqual(snapshot.status, "error")
        self.assertIsNone(snapshot.rgb_frame)
        self.assertIsNone(snapshot.emotion)
        self.assertIsNone(snapshot.candidate)
        self.assertEqual(snapshot.confidence, 0.0)
        self.assertTrue(snapshot.uncertain)
        self.assertIsNone(snapshot.features)
        self.assertEqual(snapshot.face_count, 0)
        self.assertEqual(snapshot.ai_fps, 0.0)
        self.assertEqual(snapshot.camera_index, 0)
        self.assertEqual(snapshot.resolution, (1920, 1080))


class CameraSelectionTests(unittest.TestCase):
    def test_explicit_camera_succeeds_without_ffmpeg_lookup(self) -> None:
        selected = object()
        with (
            patch.object(settings, "CAMERA_INDEX", None),
            patch.object(
                recognition,
                "_open_camera_index",
                return_value=selected,
            ) as opener,
            patch.object(
                recognition,
                "list_avfoundation_video_devices",
            ) as device_lookup,
        ):
            capture, index = recognition.open_camera(4)

        self.assertIs(capture, selected)
        self.assertEqual(index, 4)
        opener.assert_called_once_with(4)
        device_lookup.assert_not_called()

    def test_configured_camera_is_used_when_argument_is_absent(self) -> None:
        selected = object()
        with (
            patch.object(settings, "CAMERA_INDEX", 2),
            patch.object(
                recognition,
                "_open_camera_index",
                return_value=selected,
            ) as opener,
            patch.object(
                recognition,
                "list_avfoundation_video_devices",
            ) as device_lookup,
        ):
            capture, index = recognition.open_camera(None)

        self.assertIs(capture, selected)
        self.assertEqual(index, 2)
        opener.assert_called_once_with(2)
        device_lookup.assert_not_called()

    def test_named_macbook_camera_precedes_numeric_probe(self) -> None:
        selected = object()

        def open_index(index: int):
            return selected if index == 3 else None

        with (
            patch.object(settings, "CAMERA_INDEX", None),
            patch.object(
                recognition,
                "list_avfoundation_video_devices",
                return_value=[(0, "iPhone Camera"), (3, "FaceTime HD Camera")],
            ),
            patch.object(
                recognition,
                "_open_camera_index",
                side_effect=open_index,
            ) as opener,
        ):
            capture, index = recognition.open_camera(None)

        self.assertIs(capture, selected)
        self.assertEqual(index, 3)
        self.assertEqual(opener.call_args_list, [call(3)])

    def test_missing_ffmpeg_falls_back_to_probe_indices(self) -> None:
        selected = object()

        def open_index(index: int):
            return selected if index == 2 else None

        with (
            patch.object(settings, "CAMERA_INDEX", None),
            patch.object(
                recognition,
                "list_avfoundation_video_devices",
                return_value=[],
            ),
            patch.object(
                recognition,
                "_open_camera_index",
                side_effect=open_index,
            ) as opener,
        ):
            capture, index = recognition.open_camera(None)

        self.assertIs(capture, selected)
        self.assertEqual(index, 2)
        self.assertEqual(opener.call_args_list, [call(0), call(1), call(2)])

    def test_unopened_and_invalid_captures_are_released(self) -> None:
        unopened = FakeCapture(opened=False)
        invalid = FakeCapture(
            reads=[(False, None), (True, None), (False, None)]
        )
        with patch.object(
            recognition.cv2,
            "VideoCapture",
            side_effect=[unopened, invalid],
        ):
            self.assertIsNone(recognition._open_camera_index(0))
            self.assertIsNone(recognition._open_camera_index(1))

        self.assertEqual(unopened.release_count, 1)
        self.assertEqual(invalid.release_count, 1)

    def test_probe_exception_releases_capture_and_returns_none(self) -> None:
        broken = FakeCapture(opened_error=RuntimeError("camera failure"))
        with patch.object(recognition.cv2, "VideoCapture", return_value=broken):
            self.assertIsNone(recognition._open_camera_index(0))
        self.assertEqual(broken.release_count, 1)

    def test_no_ffmpeg_installation_returns_empty_device_list(self) -> None:
        with (
            patch.object(recognition.shutil, "which", return_value=None),
            patch.object(recognition, "FFMPEG_FALLBACK_PATHS", (Path("/missing"),)),
        ):
            self.assertIsNone(recognition.find_ffmpeg_executable())
            self.assertEqual(recognition.list_avfoundation_video_devices(), [])

    def test_all_camera_failures_include_frozen_permission_hint(self) -> None:
        with (
            patch.object(settings, "CAMERA_INDEX", None),
            patch.object(
                recognition,
                "list_avfoundation_video_devices",
                return_value=[],
            ),
            patch.object(recognition, "_open_camera_index", return_value=None),
            patch.object(recognition, "is_frozen", return_value=True),
        ):
            with self.assertRaisesRegex(RuntimeError, "Emotion Runner"):
                recognition.open_camera(None)

    def test_run_camera_forwards_requested_index(self) -> None:
        app = MagicMock()
        with (
            patch.object(recognition, "EmotionRecognitionApp", return_value=app),
            patch.object(
                recognition,
                "open_camera",
                side_effect=RuntimeError("stop before real camera"),
            ) as opener,
        ):
            with self.assertRaisesRegex(RuntimeError, "stop before real camera"):
                recognition.run_camera(camera_index=5)
        opener.assert_called_once_with(5)
        app.close.assert_called_once()


class EntryPointTests(unittest.TestCase):
    def test_lightweight_mediapipe_runtime_skips_unused_modules(self) -> None:
        script = """
import json
import sys
from emotion_runner.mediapipe_runtime import load_mediapipe_runtime

runtime = load_mediapipe_runtime(lightweight=True)
print(json.dumps({
    "face_landmarker": runtime.FaceLandmarker.__module__,
    "matplotlib": any(
        name == "matplotlib" or name.startswith("matplotlib.")
        for name in sys.modules
    ),
    "sounddevice": "sounddevice" in sys.modules,
    "tensorflow": any(
        name == "tensorflow" or name.startswith("tensorflow.")
        for name in sys.modules
    ),
}))
"""
        completed = subprocess.run(
            [sys.executable, "-c", script],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)

        self.assertEqual(
            result["face_landmarker"],
            "mediapipe.tasks.python.vision.face_landmarker",
        )
        self.assertFalse(result["matplotlib"])
        self.assertFalse(result["sounddevice"])
        self.assertFalse(result["tensorflow"])

    def test_smoke_test_does_not_construct_camera_worker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with (
                patch.dict(
                    os.environ,
                    {app_paths.DATA_DIR_ENV: temporary},
                ),
                patch(
                    "emotion_runner.camera_worker.CameraWorker",
                    side_effect=AssertionError("real camera worker must not start"),
                ),
            ):
                self.assertEqual(
                    runner_main.main(["--smoke-test", "--seed", "7"]),
                    0,
                )

    def test_no_camera_mode_does_not_construct_camera_worker(self) -> None:
        fake_game = MagicMock()
        with (
            patch(
                "emotion_runner.camera_worker.CameraWorker",
                side_effect=AssertionError("real camera worker must not start"),
            ),
            patch(
                "emotion_runner.game.EmotionRunnerGame",
                return_value=fake_game,
            ),
        ):
            self.assertEqual(runner_main.main(["--no-camera"]), 0)
        fake_game.run.assert_called_once_with(max_frames=None)
        fake_game.audio.shutdown.assert_called_once()

    def test_app_entry_freezes_before_project_imports(self) -> None:
        source = (PROJECT_ROOT / "app_main.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        top_level_imports = {
            alias.name
            for node in tree.body
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
        self.assertNotIn("pygame", top_level_imports)
        self.assertNotIn("cv2", top_level_imports)
        self.assertNotIn("mediapipe", top_level_imports)
        self.assertLess(
            source.index("multiprocessing.freeze_support()"),
            source.index("from emotion_runner.main import main"),
        )

    def test_spec_lists_only_required_project_models(self) -> None:
        source = (PROJECT_ROOT / "EmotionRunner.spec").read_text(encoding="utf-8")
        for filename in app_paths.REQUIRED_MODEL_FILENAMES:
            self.assertIn(filename, source)
        self.assertNotIn("emotion-ferplus-8.onnx", source)
        self.assertNotIn("opencv_face_detector_fp16.caffemodel", source)
        self.assertNotIn("opencv_face_detector_fp16.prototxt", source)
        self.assertIn("NSCameraUsageDescription", source)
        self.assertIn('"matplotlib"', source)
        self.assertIn('"sounddevice"', source)


if __name__ == "__main__":
    unittest.main()
