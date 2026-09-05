"""OpenCV DNN によるリアルタイム複数顔・表情認識。

顔検出に YuNet、表情分類に EmotiEffLib/HSEmotion の
EfficientNet-B0 8クラス ONNX モデルを使用する。検出した5点の
顔ランドマークで位置を揃え、低品質・低確信度の場合は無理に
8表情のどれかに決めず「判定不能」と表示する。MediaPipeの
478点Face Landmarkerと52種blendshapeからゲーム操作用の顔動作特徴も抽出する。
"""

from __future__ import annotations

import argparse
import math
import os
import re
import shutil
import subprocess
import threading
import time
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from emotion_runner.settings import ANALYZE_EVERY_N_FRAMES

os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("ABSL_MIN_LOG_LEVEL", "2")
os.environ.setdefault("MEDIAPIPE_LOG_LEVEL", "2")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
with warnings.catch_warnings():
    warnings.filterwarnings(
        "ignore",
        message=r"In the future `np\.object`",
        category=FutureWarning,
    )
    try:
        import mediapipe as mp
    except ImportError:
        mp = None

APP_ID = "Emotion Runner"
PROJECT_DIR = Path(__file__).resolve().parent
MODELS_DIR = PROJECT_DIR / "models"

FACE_MODEL_PATH = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
EMOTION_MODEL_PATH = MODELS_DIR / "enet_b0_8_best_vgaf.onnx"
FACE_LANDMARKER_MODEL_PATH = MODELS_DIR / "face_landmarker.task"

FACE_CONFIDENCE_THRESHOLD = 0.85
FACE_NMS_THRESHOLD = 0.30
FACE_TOP_K = 5000
TRACK_MAX_MISSING_FRAMES = 15
EMOTION_INPUT_SIZE = 224

# 判定の信頼性を優先するデフォルト。上位2クラスが近い場合も
# 「判定不能」とし、表情の切り替えには連続確認を必要とする。
EMOTION_CONFIDENCE_THRESHOLD = 0.45
EMOTION_MARGIN_THRESHOLD = 0.10
EMOTION_EMA_ALPHA = 0.55
EMOTION_SWITCH_CONFIRMATIONS = 2
EMOTION_HIGH_CONFIDENCE_SWITCH = 0.72
FACIAL_FEATURE_EMA_ALPHA = 0.45

# 1080pカメラで信頼できる顔クロップを作るための品質ゲート。
MIN_FACE_SIZE_PIXELS = 80
MIN_FACE_SHARPNESS = 20.0
MIN_FACE_BRIGHTNESS = 35.0
MAX_FACE_BRIGHTNESS = 220.0

EMOTION_MEAN = np.array((0.485, 0.456, 0.406), dtype=np.float32)
EMOTION_STD = np.array((0.229, 0.224, 0.225), dtype=np.float32)

# ArcFaceの5点テンプレートを224x224にスケールした位置。
FACE_ALIGNMENT_TEMPLATE = 2.0 * np.array(
    (
        (38.2946, 51.6963),
        (73.5318, 51.5014),
        (56.0252, 71.7366),
        (41.5493, 92.3655),
        (70.7299, 92.2041),
    ),
    dtype=np.float32,
)

# MediaPipe Face Landmarkerの口内側と口角のインデックス。
UPPER_INNER_LIP_INDEX = 13
LOWER_INNER_LIP_INDEX = 14
LEFT_MOUTH_CORNER_INDEX = 61
RIGHT_MOUTH_CORNER_INDEX = 291

WINDOW_NAME = f"{APP_ID} - Real-time Multi-face Emotion Recognition"
DEFAULT_SCREENSHOT_PATH = PROJECT_DIR / "MP-0_emotion_result.jpg"
CAMERA_FRAME_WIDTH = 1920
CAMERA_FRAME_HEIGHT = 1080
NOTEBOOK_PREVIEW_WIDTH = 1920
NOTEBOOK_PREVIEW_MAX_FPS = 12.0

# enet_b0_8_best_vgaf.onnx の公式出力順。
EMOTION_LABELS_EN = (
    "anger",
    "contempt",
    "disgust",
    "fear",
    "happiness",
    "neutral",
    "sadness",
    "surprise",
)

EMOTION_LABELS_JA = (
    "怒り",
    "軽蔑",
    "嫌悪",
    "恐れ",
    "喜び",
    "無表情",
    "悲しみ",
    "驚き",
)

QUALITY_ISSUE_LABELS = {
    "small": ("顔が小さすぎます", "face too small"),
    "blur": ("画像がぼやけています", "image too blurry"),
    "lighting": ("明るさが不適切です", "lighting unsuitable"),
    "alignment": ("顔の位置を揃えられません", "face alignment failed"),
}

TRACK_COLORS = (
    (0, 90, 255),
    (0, 200, 80),
    (255, 130, 0),
    (200, 0, 200),
    (0, 190, 220),
    (255, 80, 120),
)


Box = tuple[int, int, int, int]  # left, top, right, bottom


@dataclass(frozen=True)
class FaceDetection:
    """YuNetが返す顔位置、5点ランドマーク、確信度。"""

    confidence: float
    box: Box
    landmarks: np.ndarray = field(repr=False, compare=False)


@dataclass(frozen=True)
class FacialActionFeatures:
    """ゲーム操作に利用できる口・眉・目の特徴量。"""

    mouth_open_ratio: float
    jaw_open: float
    brow_raise: float
    brow_furrow: float
    smile: float
    eye_wide: float

    def blend(
        self,
        newer: "FacialActionFeatures",
        alpha: float = FACIAL_FEATURE_EMA_ALPHA,
    ) -> "FacialActionFeatures":
        """EMAでブレンドし、1回だけの特徴量の跳ねを抑える。"""

        weight = min(1.0, max(0.0, float(alpha)))
        previous_weight = 1.0 - weight
        return FacialActionFeatures(
            mouth_open_ratio=(
                previous_weight * self.mouth_open_ratio
                + weight * newer.mouth_open_ratio
            ),
            jaw_open=previous_weight * self.jaw_open + weight * newer.jaw_open,
            brow_raise=(
                previous_weight * self.brow_raise + weight * newer.brow_raise
            ),
            brow_furrow=(
                previous_weight * self.brow_furrow + weight * newer.brow_furrow
            ),
            smile=previous_weight * self.smile + weight * newer.smile,
            eye_wide=previous_weight * self.eye_wide + weight * newer.eye_wide,
        )


@dataclass
class CameraWindowControl:
    """OpenCV画面上のマウス操作による終了要求を保持する。"""

    quit_requested: bool = False
    quit_box: Box | None = None

    def draw_quit_button(self, frame: np.ndarray) -> None:
        """画面右上に、フォーカス不要の終了ボタンを描画する。"""

        height, width = frame.shape[:2]
        margin = 10
        button_width = min(140, max(70, width - 2 * margin))
        button_height = min(44, max(30, height - 2 * margin))
        right = width - margin
        left = max(margin, right - button_width)
        top = margin
        bottom = min(height - margin, top + button_height)
        self.quit_box = (left, top, right, bottom)

        cv2.rectangle(frame, (left, top), (right, bottom), (20, 20, 190), -1)
        cv2.rectangle(frame, (left, top), (right, bottom), (255, 255, 255), 2)

        text = "QUIT"
        text_size, baseline = cv2.getTextSize(
            text,
            cv2.FONT_HERSHEY_SIMPLEX,
            0.72,
            2,
        )
        text_x = left + max(4, (right - left - text_size[0]) // 2)
        text_y = top + max(
            text_size[1] + 2,
            (bottom - top + text_size[1] - baseline) // 2,
        )
        cv2.putText(
            frame,
            text,
            (text_x, min(bottom - 4, text_y)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.72,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )

    def handle_mouse(
        self,
        event: int,
        x: int,
        y: int,
        _flags: int,
        _parameter: object,
    ) -> None:
        """QUITボタンの左クリック、または画面の右クリックを受け取る。"""

        if event == cv2.EVENT_RBUTTONUP:
            self.quit_requested = True
            return

        if event != cv2.EVENT_LBUTTONUP or self.quit_box is None:
            return

        left, top, right, bottom = self.quit_box
        if left <= x <= right and top <= y <= bottom:
            self.quit_requested = True


def camera_window_was_closed(window_name: str) -> bool:
    """タイトルバーの閉じるボタンでOpenCV画面が閉じられたか確認する。"""

    try:
        return cv2.getWindowProperty(window_name, cv2.WND_PROP_VISIBLE) < 1
    except cv2.error:
        return True


def camera_exit_requested(
    key: int,
    window_control: CameraWindowControl,
    window_name: str = WINDOW_NAME,
) -> bool:
    """キーボード、マウス、タイトルバーのいずれかの終了要求をまとめる。"""

    return (
        key in (ord("q"), ord("Q"), 27)
        or window_control.quit_requested
        or camera_window_was_closed(window_name)
    )


def close_opencv_windows() -> None:
    """OpenCV画面を一度だけ破棄し、Cocoaの後処理を残さない。"""

    try:
        cv2.destroyWindow(WINDOW_NAME)
    except cv2.error:
        pass


@dataclass
class NotebookCameraSession:
    """Notebookのバックグラウンドカメラを停止・保存するための状態。"""

    stop_event: threading.Event = field(default_factory=threading.Event)
    save_event: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None
    error: Exception | None = None

    @property
    def is_running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def stop(self) -> None:
        self.stop_event.set()

    def request_save(self) -> None:
        self.save_event.set()

    def wait(self, timeout: float | None = None) -> None:
        if self.thread is not None:
            self.thread.join(timeout)


_active_notebook_camera_session: NotebookCameraSession | None = None


def check_required_files(paths: Iterable[Path]) -> None:
    """必要な学習済みモデルがすべて存在するか確認する。"""

    missing = [path for path in paths if not path.exists()]
    if missing:
        missing_text = "\n".join(f"- {path}" for path in missing)
        raise FileNotFoundError(f"必要なモデルファイルがありません:\n{missing_text}")


def load_yunet_detector(score_threshold: float = FACE_CONFIDENCE_THRESHOLD):
    """YuNetの顔検出器を作成する。"""

    detector_class = getattr(cv2, "FaceDetectorYN", None)
    if detector_class is None:
        raise RuntimeError(
            "現在のOpenCVにFaceDetectorYNがありません。"
            "opencv-contrib-python==4.13.0.92をインストールしてください。"
        )

    return detector_class.create(
        str(FACE_MODEL_PATH),
        "",
        (320, 320),
        float(score_threshold),
        FACE_NMS_THRESHOLD,
        FACE_TOP_K,
    )


def load_emotion_network():
    """EfficientNet-B0のONNX表情分類モデルを読み込む。"""

    onnx_loader = getattr(cv2.dnn, "readNetFromONNX", None)
    if callable(onnx_loader):
        return onnx_loader(str(EMOTION_MODEL_PATH))

    return cv2.dnn.readNet(str(EMOTION_MODEL_PATH))


def load_face_landmarker():
    """MediaPipeの478点Face Landmarkerと52種のblendshapeを読み込む。"""

    if mp is None:
        raise RuntimeError(
            "MediaPipeがインストールされていません。"
            "python3 -m pip install -r requirements.txt を実行してください。"
        )

    options = mp.tasks.vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(
            model_asset_path=str(FACE_LANDMARKER_MODEL_PATH),
        ),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_faces=1,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
        output_face_blendshapes=True,
    )
    return mp.tasks.vision.FaceLandmarker.create_from_options(options)


def load_japanese_font(size: int = 28):
    """macOS で利用可能な日本語フォントを順番に探す。"""

    font_candidates = (
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/System/Library/Fonts/YuGothic.ttc",
        "/Library/Fonts/NotoSansJP-VariableFont_wght.ttf",
        "/Library/Fonts/YuGothic.ttf",
        "/Library/Fonts/Yu Gothic.ttf",
    )

    for font_path in font_candidates:
        if Path(font_path).exists():
            try:
                return ImageFont.truetype(font_path, size=size)
            except OSError:
                continue

    return None


def softmax(scores: np.ndarray) -> np.ndarray:
    """8クラスのロジットを確率に変換する。"""

    scores = np.asarray(scores, dtype=np.float32).reshape(-1)
    shifted = scores - np.max(scores)
    exp_scores = np.exp(shifted)
    return exp_scores / np.sum(exp_scores)


def prepare_emotieff_input(face_bgr: np.ndarray) -> np.ndarray:
    """EmotiEffLib公式実装と同じRGB正規化入力を作る。"""

    if face_bgr.ndim != 3 or face_bgr.shape[2] != 3 or face_bgr.size == 0:
        raise ValueError("表情モデルの入力にはBGRの3チャンネル画像が必要です。")

    interpolation = (
        cv2.INTER_AREA
        if face_bgr.shape[0] >= EMOTION_INPUT_SIZE
        and face_bgr.shape[1] >= EMOTION_INPUT_SIZE
        else cv2.INTER_CUBIC
    )
    resized = cv2.resize(
        face_bgr,
        (EMOTION_INPUT_SIZE, EMOTION_INPUT_SIZE),
        interpolation=interpolation,
    )
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    normalized = (rgb - EMOTION_MEAN) / EMOTION_STD
    return np.ascontiguousarray(normalized.transpose(2, 0, 1)[None, ...])


def calculate_mouth_open_ratio(normalized_landmarks: np.ndarray) -> float:
    """口の縦開きを口幅で正規化した比率を返す。"""

    points = np.asarray(normalized_landmarks, dtype=np.float32)
    if points.ndim != 2 or points.shape[0] <= RIGHT_MOUTH_CORNER_INDEX:
        raise ValueError("MediaPipeの顔ランドマークが292点以上必要です。")
    if points.shape[1] < 2:
        raise ValueError("顔ランドマークにx座標とy座標が必要です。")

    lip_gap = float(
        np.linalg.norm(
            points[UPPER_INNER_LIP_INDEX, :2]
            - points[LOWER_INNER_LIP_INDEX, :2]
        )
    )
    mouth_width = float(
        np.linalg.norm(
            points[LEFT_MOUTH_CORNER_INDEX, :2]
            - points[RIGHT_MOUTH_CORNER_INDEX, :2]
        )
    )
    return lip_gap / max(mouth_width, 1e-6)


def extract_facial_action_features(
    face_landmarker: object,
    face_bgr: np.ndarray,
) -> FacialActionFeatures | None:
    """位置合わせ済み顔から口・眉・目の特徴量を返す。"""

    if mp is None:
        return None
    if face_bgr.ndim != 3 or face_bgr.shape[2] != 3 or face_bgr.size == 0:
        raise ValueError("Face LandmarkerにはBGRの3チャンネル画像が必要です。")

    face_rgb = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB)
    media_image = mp.Image(
        image_format=mp.ImageFormat.SRGB,
        data=np.ascontiguousarray(face_rgb),
    )
    result = face_landmarker.detect(media_image)
    if not result.face_landmarks:
        return None

    # fromiterを使い、478点を常に(N, 3)のfloat32配列にする。
    landmarks = np.fromiter(
        (
            coordinate
            for point in result.face_landmarks[0]
            for coordinate in (point.x, point.y, point.z)
        ),
        dtype=np.float32,
    ).reshape(-1, 3)

    blendshape_scores: dict[str, float] = {}
    if result.face_blendshapes:
        blendshape_scores = {
            str(category.category_name): float(category.score)
            for category in result.face_blendshapes[0]
            if category.category_name
        }

    def score(name: str) -> float:
        return blendshape_scores.get(name, 0.0)

    brow_outer_average = 0.5 * (
        score("browOuterUpLeft") + score("browOuterUpRight")
    )
    return FacialActionFeatures(
        mouth_open_ratio=calculate_mouth_open_ratio(landmarks),
        jaw_open=score("jawOpen"),
        brow_raise=max(score("browInnerUp"), brow_outer_average),
        brow_furrow=0.5 * (score("browDownLeft") + score("browDownRight")),
        smile=0.5 * (score("mouthSmileLeft") + score("mouthSmileRight")),
        eye_wide=0.5 * (score("eyeWideLeft") + score("eyeWideRight")),
    )


def order_five_point_landmarks(landmarks: np.ndarray) -> np.ndarray:
    """YuNetの左右表記に依存せず、画面の左から並べる。"""

    points = np.asarray(landmarks, dtype=np.float32).reshape(5, 2)
    eyes = points[:2][np.argsort(points[:2, 0])]
    mouth = points[3:5][np.argsort(points[3:5, 0])]
    return np.vstack((eyes, points[2], mouth)).astype(np.float32)


def align_face(
    bgr_image: np.ndarray,
    landmarks: np.ndarray,
) -> np.ndarray | None:
    """5点ランドマークから顔を224x224に位置合わせする。"""

    source = order_five_point_landmarks(landmarks)
    transform, _ = cv2.estimateAffinePartial2D(
        source,
        FACE_ALIGNMENT_TEMPLATE,
        method=cv2.LMEDS,
    )
    if transform is None or not np.isfinite(transform).all():
        return None

    return cv2.warpAffine(
        bgr_image,
        transform,
        (EMOTION_INPUT_SIZE, EMOTION_INPUT_SIZE),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )


def assess_face_quality(face_bgr: np.ndarray, box: Box) -> str | None:
    """表情分類を信頼できない理由コードを返す。"""

    left, top, right, bottom = box
    if min(right - left, bottom - top) < MIN_FACE_SIZE_PIXELS:
        return "small"
    if face_bgr.size == 0:
        return "alignment"

    gray = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2GRAY)
    brightness = float(np.mean(gray))
    if brightness < MIN_FACE_BRIGHTNESS or brightness > MAX_FACE_BRIGHTNESS:
        return "lighting"

    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    if sharpness < MIN_FACE_SHARPNESS:
        return "blur"
    return None


def box_center(box: Box) -> tuple[float, float]:
    left, top, right, bottom = box
    return ((left + right) / 2.0, (top + bottom) / 2.0)


def box_size(box: Box) -> float:
    left, top, right, bottom = box
    return float(max(right - left, bottom - top))


@dataclass
class FaceTrack:
    """1人分の位置、顔ランドマーク、表情の時系列を保持する。"""

    track_id: int
    box: Box
    landmarks: np.ndarray
    face_confidence: float
    last_seen_frame: int
    last_analyzed_frame: int = -1
    smoothed_probabilities: np.ndarray | None = field(
        default=None,
        repr=False,
    )
    emotion_index: int | None = None
    emotion_confidence: float = 0.0
    top_index: int | None = None
    top_confidence: float = 0.0
    emotion_margin: float = 0.0
    candidate_index: int | None = None
    candidate_count: int = 0
    quality_issue: str | None = None
    facial_features: FacialActionFeatures | None = None

    def mark_quality_issue(self, issue: str, frame_number: int) -> None:
        """低品質入力を8表情に強制分類しない。"""

        self.last_analyzed_frame = frame_number
        self.quality_issue = issue
        self.emotion_index = None
        self.emotion_confidence = 0.0
        self.top_index = None
        self.top_confidence = 0.0
        self.emotion_margin = 0.0
        self.candidate_index = None
        self.candidate_count = 0
        self.facial_features = None

    def update_facial_features(
        self,
        features: FacialActionFeatures | None,
    ) -> None:
        """顔動作特徴を更新し、時間方向の跳ねを抑える。"""

        if features is None:
            self.facial_features = None
        elif self.facial_features is None:
            self.facial_features = features
        else:
            self.facial_features = self.facial_features.blend(features)

    def update_emotion(
        self,
        probabilities: np.ndarray,
        frame_number: int,
        alpha: float = EMOTION_EMA_ALPHA,
        confidence_threshold: float = EMOTION_CONFIDENCE_THRESHOLD,
        margin_threshold: float = EMOTION_MARGIN_THRESHOLD,
    ) -> None:
        """EMA、不確定判定、連続確認で表情を安定化する。"""

        values = np.asarray(probabilities, dtype=np.float32).reshape(-1)
        if values.size != len(EMOTION_LABELS_EN):
            raise ValueError("表情確率は8クラス必要です。")
        total = float(np.sum(values))
        if not np.isfinite(values).all() or total <= 0.0:
            raise ValueError("表情確率に無効な値が含まれています。")
        values = values / total

        if self.smoothed_probabilities is None:
            self.smoothed_probabilities = values.copy()
        else:
            self.smoothed_probabilities = (
                float(alpha) * values
                + (1.0 - float(alpha)) * self.smoothed_probabilities
            )

        ranking = np.argsort(self.smoothed_probabilities)[::-1]
        top_index = int(ranking[0])
        top_confidence = float(self.smoothed_probabilities[top_index])
        second_confidence = float(self.smoothed_probabilities[int(ranking[1])])

        self.last_analyzed_frame = frame_number
        self.quality_issue = None
        self.top_index = top_index
        self.top_confidence = top_confidence
        self.emotion_margin = top_confidence - second_confidence

        is_reliable = (
            top_confidence >= confidence_threshold
            and self.emotion_margin >= margin_threshold
        )
        if not is_reliable:
            self.emotion_index = None
            self.emotion_confidence = top_confidence
            self.candidate_index = None
            self.candidate_count = 0
            return

        if self.emotion_index == top_index:
            self.emotion_confidence = top_confidence
            self.candidate_index = None
            self.candidate_count = 0
            return

        if self.candidate_index == top_index:
            self.candidate_count += 1
        else:
            self.candidate_index = top_index
            self.candidate_count = 1

        if (
            top_confidence >= EMOTION_HIGH_CONFIDENCE_SWITCH
            or self.candidate_count >= EMOTION_SWITCH_CONFIRMATIONS
        ):
            self.emotion_index = top_index
            self.emotion_confidence = top_confidence
            self.candidate_index = None
            self.candidate_count = 0
        elif self.emotion_index is not None:
            self.emotion_confidence = float(
                self.smoothed_probabilities[self.emotion_index]
            )


class CentroidFaceTracker:
    """検出した顔に短時間維持されるIDを付ける簡易トラッカー。"""

    def __init__(self, max_missing_frames: int = TRACK_MAX_MISSING_FRAMES):
        self.max_missing_frames = max_missing_frames
        self.next_track_id = 1
        self.tracks: dict[int, FaceTrack] = {}

    def update(
        self,
        detections: list[FaceDetection],
        frame_number: int,
    ) -> list[FaceTrack]:
        # 既存トラックと新しい検出の距離候補をすべて作る。
        pairs: list[tuple[float, int, int]] = []
        for track_id, track in self.tracks.items():
            tx, ty = box_center(track.box)
            for detection_index, detection in enumerate(detections):
                dx, dy = box_center(detection.box)
                distance = math.hypot(tx - dx, ty - dy)
                max_distance = 1.2 * max(
                    box_size(track.box),
                    box_size(detection.box),
                )
                if distance <= max_distance:
                    pairs.append((distance, track_id, detection_index))

        assigned_tracks: set[int] = set()
        assigned_detections: set[int] = set()

        # 近い組み合わせから割り当てる。
        for _, track_id, detection_index in sorted(pairs):
            if track_id in assigned_tracks or detection_index in assigned_detections:
                continue

            detection = detections[detection_index]
            track = self.tracks[track_id]
            track.box = detection.box
            track.landmarks = detection.landmarks.copy()
            track.face_confidence = detection.confidence
            track.last_seen_frame = frame_number
            assigned_tracks.add(track_id)
            assigned_detections.add(detection_index)

        # 既存トラックに対応しない顔には新しいIDを付ける。
        for detection_index, detection in enumerate(detections):
            if detection_index in assigned_detections:
                continue

            track_id = self.next_track_id
            self.next_track_id += 1
            self.tracks[track_id] = FaceTrack(
                track_id=track_id,
                box=detection.box,
                landmarks=detection.landmarks.copy(),
                face_confidence=detection.confidence,
                last_seen_frame=frame_number,
            )

        # 長時間見えなくなった顔の履歴を削除する。
        stale_ids = [
            track_id
            for track_id, track in self.tracks.items()
            if frame_number - track.last_seen_frame > self.max_missing_frames
        ]
        for track_id in stale_ids:
            del self.tracks[track_id]

        visible_tracks = [
            track
            for track in self.tracks.values()
            if track.last_seen_frame == frame_number
        ]
        return sorted(visible_tracks, key=lambda track: track.box[0])


class EmotionRecognitionApp:
    """顔検出・表情分類・描画をまとめたアプリケーション。"""

    def __init__(
        self,
        face_threshold: float = FACE_CONFIDENCE_THRESHOLD,
        analyze_every: int = ANALYZE_EVERY_N_FRAMES,
    ):
        check_required_files(
            (FACE_MODEL_PATH, EMOTION_MODEL_PATH, FACE_LANDMARKER_MODEL_PATH)
        )

        self.face_threshold = face_threshold
        self.analyze_every = max(1, analyze_every)
        self.face_detector = load_yunet_detector(face_threshold)
        self.face_detector_input_size: tuple[int, int] | None = None
        self.emotion_net = load_emotion_network()
        self.face_landmarker = load_face_landmarker()
        self.tracker = CentroidFaceTracker()
        self.visible_tracks: list[FaceTrack] = []
        self.japanese_font = load_japanese_font(28)

    def close(self) -> None:
        """MediaPipeの実行グラフを解放する。"""

        if self.face_landmarker is not None:
            self.face_landmarker.close()
            self.face_landmarker = None

    def detect_faces(self, bgr_image: np.ndarray) -> list[FaceDetection]:
        """YuNetで画面内の顔と5点ランドマークを検出する。"""

        image_height, image_width = bgr_image.shape[:2]
        input_size = (image_width, image_height)
        if self.face_detector_input_size != input_size:
            self.face_detector.setInputSize(input_size)
            self.face_detector_input_size = input_size

        _, faces = self.face_detector.detect(bgr_image)
        if faces is None:
            return []

        detections: list[FaceDetection] = []
        for face in faces:
            confidence = float(face[14])
            if confidence < self.face_threshold:
                continue

            raw_left, raw_top, raw_width, raw_height = face[:4]
            left = int(round(float(raw_left)))
            top = int(round(float(raw_top)))
            right = int(round(float(raw_left + raw_width)))
            bottom = int(round(float(raw_top + raw_height)))
            left = max(0, left)
            top = max(0, top)
            right = min(image_width, right)
            bottom = min(image_height, bottom)

            if right - left < 20 or bottom - top < 20:
                continue

            landmarks = np.asarray(face[4:14], dtype=np.float32).reshape(5, 2)
            detections.append(
                FaceDetection(
                    confidence=confidence,
                    box=(left, top, right, bottom),
                    landmarks=landmarks,
                )
            )

        return sorted(detections, key=lambda item: item.box[0])

    def classify_emotion(self, face_bgr: np.ndarray) -> np.ndarray:
        """位置合わせ済み顔をEfficientNet-B0に入力する。"""

        blob = prepare_emotieff_input(face_bgr)

        self.emotion_net.setInput(blob)
        scores = self.emotion_net.forward()
        return softmax(scores)

    def extract_facial_features(
        self,
        face_bgr: np.ndarray,
    ) -> FacialActionFeatures | None:
        """ゲーム操作用の口・眉・目の特徴量を返す。"""

        if self.face_landmarker is None:
            return None
        return extract_facial_action_features(self.face_landmarker, face_bgr)

    def process_frame(
        self,
        bgr_image: np.ndarray,
        frame_number: int,
        fps: float | None = None,
    ) -> np.ndarray:
        """1フレームを処理して、顔枠と表情文字を描画する。"""

        detections = self.detect_faces(bgr_image)
        tracks = self.tracker.update(detections, frame_number)
        self.visible_tracks = tracks

        for track in tracks:
            should_analyze = (
                track.last_analyzed_frame < 0
                or frame_number - track.last_analyzed_frame >= self.analyze_every
            )
            if not should_analyze:
                continue

            left, top, right, bottom = track.box
            if min(right - left, bottom - top) < MIN_FACE_SIZE_PIXELS:
                track.mark_quality_issue("small", frame_number)
                continue

            aligned_face = align_face(bgr_image, track.landmarks)
            if aligned_face is None:
                track.mark_quality_issue("alignment", frame_number)
                continue

            quality_issue = assess_face_quality(aligned_face, track.box)
            if quality_issue is not None:
                track.mark_quality_issue(quality_issue, frame_number)
                continue

            facial_features = self.extract_facial_features(aligned_face)
            track.update_facial_features(facial_features)
            probabilities = self.classify_emotion(aligned_face)
            track.update_emotion(probabilities, frame_number)

        return self.draw_result(bgr_image.copy(), tracks, fps)

    def draw_result(
        self,
        frame: np.ndarray,
        tracks: list[FaceTrack],
        fps: float | None,
    ) -> np.ndarray:
        """人ごとの顔枠、表情、操作案内を描画する。"""

        label_items: list[tuple[str, str, tuple[int, int]]] = []

        for track in tracks:
            left, top, right, bottom = track.box
            color = TRACK_COLORS[(track.track_id - 1) % len(TRACK_COLORS)]
            cv2.rectangle(frame, (left, top), (right, bottom), color, 3)

            cv2.putText(
                frame,
                f"Face: {track.face_confidence:.3f}",
                (left, min(frame.shape[0] - 8, bottom + 24)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.58,
                color,
                2,
                cv2.LINE_AA,
            )

            if track.quality_issue is not None:
                issue_ja, issue_en = QUALITY_ISSUE_LABELS.get(
                    track.quality_issue,
                    ("顔画像の品質不足", "insufficient face quality"),
                )
                label_ja = f"ID {track.track_id} 判定不能：{issue_ja}"
                label_en = f"ID {track.track_id} uncertain: {issue_en}"
            elif track.emotion_index is None and track.top_index is None:
                label_ja = f"ID {track.track_id} 分析中"
                label_en = f"ID {track.track_id} analyzing"
            elif track.emotion_index is None:
                candidate_index = int(track.top_index)
                percentage = track.top_confidence * 100.0
                label_ja = (
                    f"ID {track.track_id} 判定不能 "
                    f"（候補：{EMOTION_LABELS_JA[candidate_index]} "
                    f"{percentage:.1f}%）"
                )
                label_en = (
                    f"ID {track.track_id} uncertain "
                    f"(candidate: {EMOTION_LABELS_EN[candidate_index]} "
                    f"{percentage:.1f}%)"
                )
            else:
                index = track.emotion_index
                percentage = track.emotion_confidence * 100.0
                label_ja = (
                    f"ID {track.track_id} 表情：{EMOTION_LABELS_JA[index]} "
                    f"{percentage:.1f}%"
                )
                label_en = (
                    f"ID {track.track_id} {EMOTION_LABELS_EN[index]} "
                    f"{percentage:.1f}%"
                )

            label_y = max(4, top - 38)
            label_items.append((label_ja, label_en, (left, label_y)))

        if not tracks:
            label_items.append(("顔が検出されていません", "No face detected", (24, 52)))

        frame = self._draw_text_items(frame, label_items)

        feature_track = next(
            (track for track in tracks if track.facial_features is not None),
            None,
        )
        if feature_track is not None:
            features = feature_track.facial_features
            feature_text = (
                f"ID {feature_track.track_id}  mouth:{features.mouth_open_ratio:.2f} "
                f"jaw:{features.jaw_open:.2f}  brow+:{features.brow_raise:.2f} "
                f"brow-:{features.brow_furrow:.2f}  smile:{features.smile:.2f}"
            )
            feature_position = (20, max(20, frame.shape[0] - 78))
            cv2.putText(
                frame,
                feature_text,
                feature_position,
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (0, 0, 0),
                4,
                cv2.LINE_AA,
            )
            cv2.putText(
                frame,
                feature_text,
                feature_position,
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (255, 255, 255),
                1,
                cv2.LINE_AA,
            )

        status = f"faces: {len(tracks)}"
        if fps is not None:
            status += f"  FPS: {fps:.1f}"
        cv2.putText(
            frame,
            status,
            (20, frame.shape[0] - 48),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
        cv2.putText(
            frame,
            "s: save / q Q ESC / click QUIT",
            (20, frame.shape[0] - 18),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
        return frame

    def _draw_text_items(
        self,
        frame: np.ndarray,
        items: list[tuple[str, str, tuple[int, int]]],
    ) -> np.ndarray:
        """Pillowで日本語をまとめて描画し、文字化けを防ぐ。"""

        if self.japanese_font is None:
            for _, english_text, position in items:
                text_size, _ = cv2.getTextSize(
                    english_text,
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.68,
                    2,
                )
                x = min(
                    max(4, position[0]),
                    max(4, frame.shape[1] - text_size[0] - 6),
                )
                y = min(max(text_size[1] + 4, position[1]), frame.shape[0] - 4)
                cv2.putText(
                    frame,
                    english_text,
                    (x, y),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.68,
                    (255, 255, 255),
                    2,
                    cv2.LINE_AA,
                )
            return frame

        rgb_image = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        pil_image = Image.fromarray(rgb_image)
        drawer = ImageDraw.Draw(pil_image)

        for japanese_text, _, position in items:
            # 顔が画面の右端にあっても表情文字が切れないようにする。
            origin_box = drawer.textbbox(
                (0, 0),
                japanese_text,
                font=self.japanese_font,
                stroke_width=1,
            )
            text_width = origin_box[2] - origin_box[0]
            text_height = origin_box[3] - origin_box[1]
            x = min(
                max(4, position[0]),
                max(4, pil_image.width - text_width - 8),
            )
            y = min(
                max(4, position[1]),
                max(4, pil_image.height - text_height - 8),
            )
            text_box = drawer.textbbox(
                (x, y),
                japanese_text,
                font=self.japanese_font,
                stroke_width=1,
            )
            drawer.rectangle(
                (text_box[0] - 4, text_box[1] - 2, text_box[2] + 4, text_box[3] + 2),
                fill=(0, 0, 0),
            )
            drawer.text(
                (x, y),
                japanese_text,
                font=self.japanese_font,
                fill=(255, 255, 255),
                stroke_width=1,
                stroke_fill=(0, 0, 0),
            )

        return cv2.cvtColor(np.asarray(pil_image), cv2.COLOR_RGB2BGR)


def list_avfoundation_video_devices() -> list[tuple[int, str]]:
    """FFmpegからAVFoundationのカメラindexとデバイス名を取得する。"""

    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        return []

    try:
        result = subprocess.run(
            (
                ffmpeg_path,
                "-hide_banner",
                "-f",
                "avfoundation",
                "-list_devices",
                "true",
                "-i",
                "",
            ),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []

    devices: list[tuple[int, str]] = []
    reading_video_devices = False
    for line in f"{result.stdout}\n{result.stderr}".splitlines():
        if "AVFoundation video devices:" in line:
            reading_video_devices = True
            continue
        if "AVFoundation audio devices:" in line:
            reading_video_devices = False
            continue
        if not reading_video_devices:
            continue

        match = re.search(r"\]\s+\[(\d+)\]\s+(.+)$", line)
        if match is None:
            continue
        device_name = match.group(2).strip()
        if device_name.lower().startswith("capture screen"):
            continue
        devices.append((int(match.group(1)), device_name))

    return devices


def find_macbook_camera(
    devices: list[tuple[int, str]],
) -> tuple[int, str] | None:
    """名前からMacBook内蔵カメラを特定する。"""

    built_in_markers = ("facetime", "macbook", "built-in", "内蔵")
    for camera_index, device_name in devices:
        normalized_name = device_name.casefold()
        if "iphone" in normalized_name:
            continue
        if any(marker in normalized_name for marker in built_in_markers):
            return camera_index, device_name
    return None


def open_camera(preferred_index: int | None) -> tuple[cv2.VideoCapture, int]:
    """指定index、または名前で検出したMacBook内蔵カメラを開く。"""

    devices = list_avfoundation_video_devices()
    if preferred_index is None:
        selected_device = find_macbook_camera(devices)
        if selected_device is None:
            device_text = (
                ", ".join(f"{index}: {name}" for index, name in devices)
                or "取得できませんでした"
            )
            raise RuntimeError(
                "MacBook内蔵カメラを名前で検出できません。"
                f" AVFoundationデバイス: {device_text}"
            )
        camera_index, device_name = selected_device
        print(
            f"MacBook内蔵カメラを選択しました: "
            f"index={camera_index}, name={device_name}"
        )
    else:
        camera_index = preferred_index
        device_name = next(
            (name for index, name in devices if index == camera_index),
            f"index {camera_index}",
        )

    capture = cv2.VideoCapture(camera_index, cv2.CAP_AVFOUNDATION)
    if capture.isOpened():
        return capture, camera_index
    capture.release()

    device_text = (
        ", ".join(f"{index}: {name}" for index, name in devices)
        or "取得できませんでした"
    )
    raise RuntimeError(
        f"カメラを開けませんでした: index={camera_index}, "
        f"name={device_name}。AVFoundationデバイス: {device_text}。"
        "macOSの「システム設定 > プライバシーとセキュリティ > "
        "カメラ」でVisual Studio Codeを許可し、VS Codeを完全に終了して"
        "開き直してください。iPhoneに切り替える回避は行いません。"
    )


def run_camera(
    camera_index: int | None = None,
    screenshot_path: Path = DEFAULT_SCREENSHOT_PATH,
) -> None:
    """カメラを開いてリアルタイム表情認識を実行する。"""

    app = EmotionRecognitionApp()
    try:
        capture, active_camera_index = open_camera(1)
    except Exception:
        app.close()
        raise

    capture.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_FRAME_WIDTH)
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_FRAME_HEIGHT)

    window_control = CameraWindowControl()
    try:
        cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)
        cv2.setMouseCallback(WINDOW_NAME, window_control.handle_mouse)
    except Exception:
        capture.release()
        close_opencv_windows()
        raise

    print(
        "リアルタイム複数顔・表情認識を開始しました。"
        f" camera index={active_camera_index}"
    )
    print(
        "sキー：画面を保存 / q・Q・ESC、赤いQUITボタン、右クリック、"
        "またはウィンドウを閉じる：終了"
    )

    frame_number = 0
    previous_time = time.perf_counter()
    smoothed_fps: float | None = None

    try:
        while True:
            ret, frame = capture.read()
            if not ret:
                print("カメラ画像を取得できませんでした。")
                break

            if frame_number == 0:
                frame_height, frame_width = frame.shape[:2]
                print(f"実際のカメラ解像度: {frame_width}x{frame_height}")

            # 鏡と同じ向きで表示する。
            frame = cv2.flip(frame, 1)
            current_time = time.perf_counter()
            elapsed = max(current_time - previous_time, 1e-6)
            current_fps = 1.0 / elapsed
            previous_time = current_time
            smoothed_fps = (
                current_fps
                if smoothed_fps is None
                else 0.90 * smoothed_fps + 0.10 * current_fps
            )

            result = app.process_frame(frame, frame_number, smoothed_fps)
            window_control.draw_quit_button(result)
            cv2.imshow(WINDOW_NAME, result)

            raw_key = cv2.waitKeyEx(15)
            key = raw_key & 0xFF if raw_key >= 0 else -1
            if key == ord("s"):
                cv2.imwrite(str(screenshot_path), result)
                print(f"スナップショットを保存しました: {screenshot_path}")
            elif camera_exit_requested(key, window_control):
                print("リアルタイム表情認識を終了します。")
                break

            frame_number += 1
    except KeyboardInterrupt:
        print("Notebookの中断を受け取り、カメラを終了します。")
    finally:
        capture.release()
        close_opencv_windows()
        app.close()


def run_camera_in_notebook(
    camera_index: int | None = None,
    screenshot_path: Path = DEFAULT_SCREENSHOT_PATH,
    preview_max_fps: float = NOTEBOOK_PREVIEW_MAX_FPS,
) -> NotebookCameraSession:
    """VS Code Notebookの出力欄に、停止可能なカメラ映像を表示する。"""

    global _active_notebook_camera_session

    try:
        import ipywidgets as widgets
        from IPython.display import display
    except ImportError as error:
        raise RuntimeError("Notebook表示にはipywidgetsとIPythonが必要です。") from error

    if preview_max_fps <= 0:
        raise ValueError("preview_max_fpsは0より大きい値にしてください。")

    if (
        _active_notebook_camera_session is not None
        and _active_notebook_camera_session.is_running
    ):
        raise RuntimeError(
            "Notebookカメラはすでに実行中です。赤い停止ボタンで終了してください。"
        )

    app = EmotionRecognitionApp()
    try:
        capture, active_camera_index = open_camera(camera_index)
    except Exception:
        app.close()
        raise
    capture.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_FRAME_WIDTH)
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_FRAME_HEIGHT)

    preview = widgets.Image(
        format="jpeg",
        layout=widgets.Layout(width="100%", max_width="1920px", height="auto"),
    )
    stop_button = widgets.Button(
        description="カメラを停止",
        button_style="danger",
        icon="stop",
    )
    save_button = widgets.Button(
        description="画像を保存",
        button_style="info",
        icon="camera",
    )
    status = widgets.HTML(
        value=(
            f"<b>起動中</b> — MacBookカメラ index={active_camera_index}, "
            f"要求解像度={CAMERA_FRAME_WIDTH}x{CAMERA_FRAME_HEIGHT}"
        )
    )
    session = NotebookCameraSession()

    def request_stop(_button: object) -> None:
        session.stop()
        stop_button.disabled = True
        status.value = "<b>終了処理中...</b>"

    def request_save(_button: object) -> None:
        session.request_save()

    stop_button.on_click(request_stop)
    save_button.on_click(request_save)
    controls = widgets.HBox((stop_button, save_button, status))
    display(widgets.VBox((controls, preview)))

    def camera_worker() -> None:
        frame_number = 0
        previous_time = time.perf_counter()
        smoothed_fps: float | None = None
        next_preview_time = 0.0

        try:
            while not session.stop_event.is_set():
                ret, frame = capture.read()
                if not ret:
                    status.value = "<b>カメラ画像を取得できませんでした。</b>"
                    break

                if frame_number == 0:
                    frame_height, frame_width = frame.shape[:2]
                    resolution_text = f"実解像度={frame_width}x{frame_height}"
                    if (frame_width, frame_height) != (
                        CAMERA_FRAME_WIDTH,
                        CAMERA_FRAME_HEIGHT,
                    ):
                        resolution_text += "（カメラが1080p要求を受理しませんでした）"
                    status.value = (
                        f"<b>実行中</b> — MacBookカメラ "
                        f"index={active_camera_index}, {resolution_text}"
                    )

                frame = cv2.flip(frame, 1)
                current_time = time.perf_counter()
                elapsed = max(current_time - previous_time, 1e-6)
                current_fps = 1.0 / elapsed
                previous_time = current_time
                smoothed_fps = (
                    current_fps
                    if smoothed_fps is None
                    else 0.90 * smoothed_fps + 0.10 * current_fps
                )

                result = app.process_frame(frame, frame_number, smoothed_fps)
                if session.save_event.is_set():
                    session.save_event.clear()
                    cv2.imwrite(str(screenshot_path), result)
                    status.value = f"<b>保存しました:</b> {screenshot_path.name}"

                if current_time >= next_preview_time:
                    preview_frame = result
                    if result.shape[1] > NOTEBOOK_PREVIEW_WIDTH:
                        preview_height = round(
                            result.shape[0] * NOTEBOOK_PREVIEW_WIDTH / result.shape[1]
                        )
                        preview_frame = cv2.resize(
                            result,
                            (NOTEBOOK_PREVIEW_WIDTH, preview_height),
                        )
                    encoded, jpeg = cv2.imencode(
                        ".jpg",
                        preview_frame,
                        (cv2.IMWRITE_JPEG_QUALITY, 82),
                    )
                    if encoded:
                        preview.value = jpeg.tobytes()
                    next_preview_time = current_time + 1.0 / preview_max_fps

                frame_number += 1
        except Exception as error:
            session.error = error
            status.value = f"<b>カメラ処理エラー:</b> {type(error).__name__}: {error}"
        finally:
            capture.release()
            app.close()
            stop_button.disabled = True
            save_button.disabled = True
            if session.error is None:
                status.value = "<b>カメラを終了しました。Notebookは操作可能です。</b>"

    session.thread = threading.Thread(
        target=camera_worker,
        name="notebook-emotion-camera",
        daemon=True,
    )
    _active_notebook_camera_session = session
    session.thread.start()
    return session


def process_still_image(
    input_path: Path,
    output_path: Path,
) -> None:
    """カメラを使わず、1枚の画像で動作確認する。"""

    image = cv2.imread(str(input_path))
    if image is None:
        raise FileNotFoundError(f"画像を読み込めません: {input_path}")

    app = EmotionRecognitionApp(analyze_every=1)
    result = image.copy()
    try:
        # 静止画像でもリアルタイムと同じ連続確認を完了させる。
        for frame_number in range(EMOTION_SWITCH_CONFIRMATIONS):
            result = app.process_frame(image, frame_number=frame_number)
    finally:
        app.close()
    cv2.imwrite(str(output_path), result)
    print(f"認識結果を保存しました: {output_path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="OpenCV DNNによるリアルタイム複数顔・表情認識"
    )
    parser.add_argument(
        "--camera",
        type=int,
        default=None,
        help="カメラ番号。省略時は名前からMacBook内蔵カメラを自動選択する。",
    )
    parser.add_argument(
        "--image",
        type=Path,
        help="指定した場合はカメラではなく静止画像を処理する。",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="静止画像モードの出力先。",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.image is not None:
        output_path = args.output or PROJECT_DIR / f"MP-0_{APP_ID}_image_result.jpg"
        process_still_image(args.image, output_path)
    else:
        run_camera(camera_index=args.camera)


if __name__ == "__main__":
    main()
