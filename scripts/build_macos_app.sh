#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: this build script must run on macOS." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Keep build verification isolated from the player's real high score.
TEST_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/emotion-runner-build.XXXXXX")"
trap 'rm -rf "$TEST_DATA_DIR"' EXIT
export EMOTION_RUNNER_DATA_DIR="$TEST_DATA_DIR"
export PYINSTALLER_STRICT_BUNDLE_CODESIGN_ERROR=1

PYTHON_BIN="${PYTHON:-python}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Error: activate the app virtual environment before building." >&2
  exit 1
fi

echo "Python: $($PYTHON_BIN --version 2>&1)"
echo "Interpreter: $($PYTHON_BIN -c 'import sys; print(sys.executable)')"
echo "CPU architecture: $($PYTHON_BIN -c 'import platform; print(platform.machine())')"

required_models=(
  "models/face_detection_yunet_2023mar.onnx"
  "models/enet_b0_8_best_vgaf.onnx"
  "models/face_landmarker.task"
)
for model in "${required_models[@]}"; do
  if [[ ! -f "$model" ]]; then
    echo "Error: required model is missing: $model" >&2
    exit 1
  fi
done

echo "Running unit tests..."
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  "$PYTHON_BIN" -m unittest discover -s tests -v

echo "Running source smoke tests..."
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  "$PYTHON_BIN" -m emotion_runner --smoke-test --seed 7
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  "$PYTHON_BIN" app_main.py --smoke-test --seed 7

# Finder can recreate a top-level .DS_Store while generated directories are
# being removed. Retry only that harmless residue and fail on any other file.
rm -rf build dist || true
for generated_dir in build dist; do
  if [[ -d "$generated_dir" ]]; then
    find "$generated_dir" -type f -name .DS_Store -delete
    find "$generated_dir" -depth -type d -empty -delete
  fi
  if [[ -e "$generated_dir" ]]; then
    echo "Error: could not clean generated directory: $generated_dir" >&2
    exit 1
  fi
done

echo "Building Emotion Runner.app..."
"$PYTHON_BIN" -m PyInstaller --noconfirm --clean EmotionRunner.spec

APP_PATH="$ROOT_DIR/dist/Emotion Runner.app"
APP_EXECUTABLE="$APP_PATH/Contents/MacOS/Emotion Runner"
INFO_PLIST="$APP_PATH/Contents/Info.plist"

if [[ ! -d "$APP_PATH" || ! -x "$APP_EXECUTABLE" ]]; then
  echo "Error: expected application was not created: $APP_PATH" >&2
  exit 1
fi

echo "Running packaged smoke test..."
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  "$APP_EXECUTABLE" --smoke-test --seed 7

camera_usage="$(plutil -extract NSCameraUsageDescription raw -o - "$INFO_PLIST")"
if [[ -z "$camera_usage" ]]; then
  echo "Error: NSCameraUsageDescription is missing." >&2
  exit 1
fi
echo "Camera usage description: $camera_usage"

if codesign --verify --deep --strict "$APP_PATH"; then
  echo "Code-signature verification: passed"
else
  echo "Warning: code-signature verification failed." >&2
fi

echo "Signed entitlements:"
codesign --display --entitlements - "$APP_PATH" 2>&1 || true
echo "Application executable: $(file "$APP_EXECUTABLE")"
echo "Application architectures: $(lipo -archs "$APP_EXECUTABLE")"
echo "Build complete: $APP_PATH"
