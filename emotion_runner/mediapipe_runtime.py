"""Load only the MediaPipe APIs required by Emotion Runner."""

from __future__ import annotations

from dataclasses import dataclass
from importlib.machinery import ModuleSpec
from importlib.util import find_spec
from pathlib import Path
import sys
from types import ModuleType
from typing import Any


@dataclass(frozen=True)
class MediaPipeRuntime:
    """Small stable surface used by the face-landmarker integration."""

    BaseOptions: Any
    FaceLandmarker: Any
    FaceLandmarkerOptions: Any
    RunningMode: Any
    Image: Any
    ImageFormat: Any


def _register_package_shell(name: str, directory: Path) -> None:
    """Register a package path without executing its heavyweight __init__."""

    if name in sys.modules:
        return

    module = ModuleType(name)
    module.__file__ = str(directory / "__init__.py")
    module.__package__ = name
    module.__path__ = [str(directory)]
    module_spec = ModuleSpec(name, loader=None, is_package=True)
    module_spec.submodule_search_locations = [str(directory)]
    module.__spec__ = module_spec
    sys.modules[name] = module

    parent_name, _, child_name = name.rpartition(".")
    if parent_name and parent_name in sys.modules:
        setattr(sys.modules[parent_name], child_name, module)


def _register_optional_dependencies_stub() -> None:
    """Skip TensorFlow, which MediaPipe uses only for API documentation."""

    module_name = "mediapipe.tasks.python.core.optional_dependencies"
    if module_name in sys.modules:
        return

    def do_not_generate_docs(value: Any) -> Any:
        return value

    doc_controls = ModuleType("doc_controls")
    doc_controls.do_not_generate_docs = do_not_generate_docs

    module = ModuleType(module_name)
    module.__package__ = module_name.rpartition(".")[0]
    module.__spec__ = ModuleSpec(module_name, loader=None)
    module.doc_controls = doc_controls
    sys.modules[module_name] = module

    parent_name, _, child_name = module_name.rpartition(".")
    setattr(sys.modules[parent_name], child_name, module)


def _prepare_lightweight_packages() -> None:
    """Avoid MediaPipe's unused plotting/audio imports in the frozen app."""

    if "mediapipe" in sys.modules:
        return

    package_spec = find_spec("mediapipe")
    locations = (
        tuple(package_spec.submodule_search_locations or ())
        if package_spec is not None
        else ()
    )
    if not locations:
        raise ImportError("MediaPipe package directory was not found")

    root = Path(locations[0])
    _register_package_shell("mediapipe", root)
    _register_package_shell("mediapipe.tasks", root / "tasks")
    _register_package_shell("mediapipe.tasks.python", root / "tasks" / "python")
    _register_package_shell(
        "mediapipe.tasks.python.core",
        root / "tasks" / "python" / "core",
    )
    _register_package_shell(
        "mediapipe.tasks.python.vision",
        root / "tasks" / "python" / "vision",
    )
    _register_optional_dependencies_stub()


def load_mediapipe_runtime(*, lightweight: bool) -> MediaPipeRuntime:
    """Return Face Landmarker classes, optionally skipping broad package APIs."""

    if lightweight:
        _prepare_lightweight_packages()
        from mediapipe.tasks.python.core.base_options import BaseOptions
        from mediapipe.tasks.python.vision.core.image import Image, ImageFormat
        from mediapipe.tasks.python.vision.core.vision_task_running_mode import (
            VisionTaskRunningMode,
        )
        from mediapipe.tasks.python.vision.face_landmarker import (
            FaceLandmarker,
            FaceLandmarkerOptions,
        )

        return MediaPipeRuntime(
            BaseOptions=BaseOptions,
            FaceLandmarker=FaceLandmarker,
            FaceLandmarkerOptions=FaceLandmarkerOptions,
            RunningMode=VisionTaskRunningMode,
            Image=Image,
            ImageFormat=ImageFormat,
        )

    import mediapipe

    return MediaPipeRuntime(
        BaseOptions=mediapipe.tasks.BaseOptions,
        FaceLandmarker=mediapipe.tasks.vision.FaceLandmarker,
        FaceLandmarkerOptions=mediapipe.tasks.vision.FaceLandmarkerOptions,
        RunningMode=mediapipe.tasks.vision.RunningMode,
        Image=mediapipe.Image,
        ImageFormat=mediapipe.ImageFormat,
    )
