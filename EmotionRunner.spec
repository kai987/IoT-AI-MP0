# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller configuration for the macOS Emotion Runner app."""

import os
import platform
from pathlib import Path

from PyInstaller.utils.hooks import collect_all


ROOT = Path(SPEC).resolve().parent
CODESIGN_IDENTITY = os.environ.get("CODESIGN_IDENTITY") or None
ENTITLEMENTS = ROOT / "packaging" / "macos.entitlements"
TARGET_ARCH = platform.machine()


def mediapipe_runtime_submodule(module_name):
    """Collect only the Python closure used by the Face Landmarker C API."""

    package_nodes = {
        "mediapipe",
        "mediapipe.tasks",
        "mediapipe.tasks.c",
        "mediapipe.tasks.python",
        "mediapipe.tasks.python.components",
        "mediapipe.tasks.python.core",
        "mediapipe.tasks.python.vision",
    }
    runtime_prefixes = (
        "mediapipe.tasks.python.components.containers",
        "mediapipe.tasks.python.core",
        "mediapipe.tasks.python.vision.core",
        "mediapipe.tasks.python.vision.face_landmarker",
    )
    return module_name in package_nodes or any(
        module_name == prefix or module_name.startswith(f"{prefix}.")
        for prefix in runtime_prefixes
    )


mediapipe_datas, mediapipe_binaries, mediapipe_hiddenimports = collect_all(
    "mediapipe",
    include_py_files=False,
    filter_submodules=mediapipe_runtime_submodule,
)

application_resources = [
    (str(ROOT / "models" / "face_detection_yunet_2023mar.onnx"), "models"),
    (str(ROOT / "models" / "enet_b0_8_best_vgaf.onnx"), "models"),
    (str(ROOT / "models" / "face_landmarker.task"), "models"),
    (str(ROOT / "models" / "LICENSE-YUNET.txt"), "models"),
    (str(ROOT / "models" / "LICENSE-EMOTIEFFLIB.txt"), "models"),
    (str(ROOT / "models" / "LICENSE-MEDIAPIPE.txt"), "models"),
    (str(ROOT / "models" / "MODEL_SOURCES.md"), "models"),
]

a = Analysis(
    [str(ROOT / "app_main.py")],
    pathex=[str(ROOT)],
    binaries=mediapipe_binaries,
    datas=application_resources + mediapipe_datas,
    hiddenimports=mediapipe_hiddenimports
    + [
        "emotion_recognition",
        "emotion_runner.camera_worker",
        "emotion_runner.main",
        "emotion_runner.mediapipe_runtime",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "IPython",
        "ipywidgets",
        "jupyter",
        "matplotlib",
        "notebook",
        "sounddevice",
        "tensorflow",
        "torch",
        "jax",
        "tests",
        "mediapipe.tasks.python.audio",
        "mediapipe.tasks.python.benchmark",
        "mediapipe.tasks.python.genai",
        "mediapipe.tasks.python.metadata",
        "mediapipe.tasks.python.test",
        "mediapipe.tasks.python.text",
        "mediapipe.tasks.python.vision.drawing_styles",
        "mediapipe.tasks.python.vision.drawing_utils",
        "mediapipe.tasks.python.vision.face_detector",
        "mediapipe.tasks.python.vision.gesture_recognizer",
        "mediapipe.tasks.python.vision.hand_landmarker",
        "mediapipe.tasks.python.vision.holistic_landmarker",
        "mediapipe.tasks.python.vision.image_classifier",
        "mediapipe.tasks.python.vision.image_embedder",
        "mediapipe.tasks.python.vision.image_segmenter",
        "mediapipe.tasks.python.vision.interactive_segmenter",
        "mediapipe.tasks.python.vision.object_detector",
        "mediapipe.tasks.python.vision.pose_landmarker",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Emotion Runner",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    argv_emulation=False,
    target_arch=TARGET_ARCH,
    codesign_identity=CODESIGN_IDENTITY,
    entitlements_file=str(ENTITLEMENTS),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Emotion Runner",
)

app = BUNDLE(
    coll,
    name="Emotion Runner.app",
    icon=None,
    bundle_identifier="io.github.kai987.emotionrunner",
    info_plist={
        "CFBundleDisplayName": "Emotion Runner",
        "NSCameraUsageDescription": (
            "表情認識によるゲーム操作のため、カメラを使用します。"
            "映像は端末内で処理され、外部へ送信されません。"
        ),
        "NSHighResolutionCapable": True,
        "LSApplicationCategoryType": "public.app-category.games",
    },
    target_arch=TARGET_ARCH,
    codesign_identity=CODESIGN_IDENTITY,
    entitlements_file=str(ENTITLEMENTS),
)
