"""emotion_recognition.py の前処理・品質判定・時系列制御のテスト。"""

from __future__ import annotations

import unittest
from pathlib import Path

import cv2
import numpy as np

import emotion_recognition as er


def probability_vector(first: float, second: float = 0.0) -> np.ndarray:
    values = np.zeros(len(er.EMOTION_LABELS_EN), dtype=np.float32)
    values[0] = first
    values[1] = second
    if first + second < 1.0:
        values[2] = 1.0 - first - second
    return values


def make_track() -> er.FaceTrack:
    return er.FaceTrack(
        track_id=1,
        box=(10, 10, 150, 150),
        landmarks=np.zeros((5, 2), dtype=np.float32),
        face_confidence=0.99,
        last_seen_frame=0,
    )


class PreprocessingTests(unittest.TestCase):
    def test_model_label_order_matches_emotiefflib(self) -> None:
        self.assertEqual(
            er.EMOTION_LABELS_EN,
            (
                "anger",
                "contempt",
                "disgust",
                "fear",
                "happiness",
                "neutral",
                "sadness",
                "surprise",
            ),
        )

    def test_preprocessing_converts_bgr_to_rgb_and_normalizes(self) -> None:
        red_bgr = np.zeros((16, 16, 3), dtype=np.uint8)
        red_bgr[:, :] = (0, 0, 255)

        blob = er.prepare_emotieff_input(red_bgr)

        self.assertEqual(blob.shape, (1, 3, 224, 224))
        expected = np.array(
            (
                (1.0 - er.EMOTION_MEAN[0]) / er.EMOTION_STD[0],
                (0.0 - er.EMOTION_MEAN[1]) / er.EMOTION_STD[1],
                (0.0 - er.EMOTION_MEAN[2]) / er.EMOTION_STD[2],
            ),
            dtype=np.float32,
        )
        np.testing.assert_allclose(blob[0, :, 100, 100], expected, rtol=1e-5)

    def test_landmarks_are_ordered_from_image_left_to_right(self) -> None:
        landmarks = np.array(
            ((80, 40), (20, 41), (50, 65), (75, 90), (25, 91)),
            dtype=np.float32,
        )

        ordered = er.order_five_point_landmarks(landmarks)

        np.testing.assert_array_equal(
            ordered,
            np.array(
                ((20, 41), (80, 40), (50, 65), (25, 91), (75, 90)),
                dtype=np.float32,
            ),
        )

    def test_alignment_returns_224_square(self) -> None:
        image = np.full((224, 224, 3), 127, dtype=np.uint8)
        aligned = er.align_face(image, er.FACE_ALIGNMENT_TEMPLATE.copy())
        self.assertIsNotNone(aligned)
        self.assertEqual(aligned.shape, (224, 224, 3))


class QualityGateTests(unittest.TestCase):
    def test_small_face_is_rejected(self) -> None:
        face = np.full((224, 224, 3), 127, dtype=np.uint8)
        self.assertEqual(er.assess_face_quality(face, (0, 0, 79, 120)), "small")

    def test_extreme_darkness_is_rejected(self) -> None:
        dark = np.zeros((224, 224, 3), dtype=np.uint8)
        self.assertEqual(er.assess_face_quality(dark, (0, 0, 120, 120)), "lighting")

    def test_flat_image_is_rejected_as_blurry(self) -> None:
        flat = np.full((224, 224, 3), 127, dtype=np.uint8)
        self.assertEqual(er.assess_face_quality(flat, (0, 0, 120, 120)), "blur")

    def test_clear_checkerboard_passes(self) -> None:
        rows, columns = np.indices((224, 224))
        gray = (((rows // 16 + columns // 16) % 2) * 150 + 50).astype(np.uint8)
        face = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        self.assertIsNone(er.assess_face_quality(face, (0, 0, 120, 120)))


class FacialFeatureTests(unittest.TestCase):
    def test_mouth_open_ratio_is_normalized_by_mouth_width(self) -> None:
        landmarks = np.zeros((478, 3), dtype=np.float32)
        landmarks[er.LEFT_MOUTH_CORNER_INDEX, :2] = (0.0, 0.5)
        landmarks[er.RIGHT_MOUTH_CORNER_INDEX, :2] = (1.0, 0.5)
        landmarks[er.UPPER_INNER_LIP_INDEX, :2] = (0.5, 0.4)
        landmarks[er.LOWER_INNER_LIP_INDEX, :2] = (0.5, 0.6)

        ratio = er.calculate_mouth_open_ratio(landmarks)

        self.assertAlmostEqual(ratio, 0.20, places=5)

    def test_feature_blend_uses_exponential_moving_average(self) -> None:
        previous = er.FacialActionFeatures(0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        newer = er.FacialActionFeatures(1.0, 0.8, 0.6, 0.4, 0.2, 1.0)

        blended = previous.blend(newer, alpha=0.25)

        self.assertAlmostEqual(blended.mouth_open_ratio, 0.25)
        self.assertAlmostEqual(blended.jaw_open, 0.20)
        self.assertAlmostEqual(blended.brow_raise, 0.15)
        self.assertAlmostEqual(blended.brow_furrow, 0.10)
        self.assertAlmostEqual(blended.smile, 0.05)
        self.assertAlmostEqual(blended.eye_wide, 0.25)


class TemporalDecisionTests(unittest.TestCase):
    def test_low_confidence_is_unknown(self) -> None:
        track = make_track()
        probabilities = np.array(
            (0.40, 0.25, 0.10, 0.08, 0.06, 0.05, 0.04, 0.02),
            dtype=np.float32,
        )

        track.update_emotion(probabilities, frame_number=0, alpha=1.0)

        self.assertIsNone(track.emotion_index)
        self.assertEqual(track.top_index, 0)

    def test_small_top_two_margin_is_unknown(self) -> None:
        track = make_track()
        probabilities = np.array(
            (0.50, 0.44, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01),
            dtype=np.float32,
        )

        track.update_emotion(probabilities, frame_number=0, alpha=1.0)

        self.assertIsNone(track.emotion_index)
        self.assertLess(track.emotion_margin, er.EMOTION_MARGIN_THRESHOLD)

    def test_normal_confidence_requires_two_confirmations(self) -> None:
        track = make_track()
        probabilities = probability_vector(0.60, 0.10)

        track.update_emotion(probabilities, frame_number=0, alpha=1.0)
        self.assertIsNone(track.emotion_index)

        track.update_emotion(probabilities, frame_number=3, alpha=1.0)
        self.assertEqual(track.emotion_index, 0)
        self.assertAlmostEqual(track.emotion_confidence, 0.60, places=5)

    def test_high_confidence_can_be_published_immediately(self) -> None:
        track = make_track()
        probabilities = probability_vector(0.80, 0.05)

        track.update_emotion(probabilities, frame_number=0, alpha=1.0)

        self.assertEqual(track.emotion_index, 0)

    def test_quality_failure_clears_published_emotion(self) -> None:
        track = make_track()
        probabilities = probability_vector(0.80, 0.05)
        track.update_emotion(probabilities, frame_number=0, alpha=1.0)
        track.update_facial_features(
            er.FacialActionFeatures(0.2, 0.3, 0.4, 0.1, 0.0, 0.2)
        )

        track.mark_quality_issue("blur", frame_number=3)

        self.assertIsNone(track.emotion_index)
        self.assertEqual(track.quality_issue, "blur")
        self.assertIsNone(track.facial_features)


class TrackerTests(unittest.TestCase):
    def test_tracker_preserves_id_and_updates_landmarks(self) -> None:
        tracker = er.CentroidFaceTracker()
        first_landmarks = np.arange(10, dtype=np.float32).reshape(5, 2)
        second_landmarks = first_landmarks + 3
        first = er.FaceDetection(0.95, (10, 10, 110, 110), first_landmarks)
        second = er.FaceDetection(0.96, (14, 12, 114, 112), second_landmarks)

        first_tracks = tracker.update([first], frame_number=0)
        second_tracks = tracker.update([second], frame_number=1)

        self.assertEqual(first_tracks[0].track_id, second_tracks[0].track_id)
        np.testing.assert_array_equal(second_tracks[0].landmarks, second_landmarks)


class ModelIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = er.EmotionRecognitionApp(analyze_every=1)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.app.close()

    def test_models_load_and_emotion_output_is_probability_vector(self) -> None:
        face = np.full((224, 224, 3), 127, dtype=np.uint8)
        probabilities = self.app.classify_emotion(face)

        self.assertEqual(probabilities.shape, (8,))
        self.assertTrue(np.isfinite(probabilities).all())
        self.assertAlmostEqual(float(probabilities.sum()), 1.0, places=5)

    def test_existing_project_image_runs_end_to_end(self) -> None:
        image_path = Path(__file__).resolve().parents[1] / "MP-0_M25W0243_test_result.jpg"
        image = cv2.imread(str(image_path))
        self.assertIsNotNone(image)

        detections = self.app.detect_faces(image)
        result = self.app.process_frame(image, frame_number=0)

        self.assertGreaterEqual(len(detections), 1)
        self.assertEqual(result.shape, image.shape)

    def test_face_landmarker_returns_action_features(self) -> None:
        image_path = Path(__file__).resolve().parents[1] / "MP-0_M25W0243_test_result.jpg"
        image = cv2.imread(str(image_path))
        detections = self.app.detect_faces(image)
        largest = max(detections, key=lambda item: er.box_size(item.box))
        aligned = er.align_face(image, largest.landmarks)

        features = self.app.extract_facial_features(aligned)

        self.assertIsNotNone(features)
        values = np.array(
            (
                features.mouth_open_ratio,
                features.jaw_open,
                features.brow_raise,
                features.brow_furrow,
                features.smile,
                features.eye_wide,
            )
        )
        self.assertTrue(np.isfinite(values).all())
        self.assertTrue((values >= 0.0).all())


if __name__ == "__main__":
    unittest.main()
