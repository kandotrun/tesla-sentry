from __future__ import annotations

import unittest
from itertools import pairwise

from sentry_analyzer.camera_activity import analyze_camera_frames
from sentry_analyzer.near_camera_activity import (
    NearCameraActivityDetector,
    measure_near_camera_change,
)
from sentry_analyzer.temporal_activity import GrayFrame

WIDTH = 160
HEIGHT = 104


def textured_frame(index: int, variant: int = 0) -> GrayFrame:
    pixels = bytes(
        (x * (17 + variant * 13) + y * (31 + variant * 7) + variant * 97) % 256
        for y in range(HEIGHT)
        for x in range(WIDTH)
    )
    return GrayFrame(index * 125, pixels)


def occluded_frame(index: int, occlusion_value: int | None) -> GrayFrame:
    pixels = bytearray((x + y * 2) % 64 for y in range(HEIGHT) for x in range(WIDTH))
    if occlusion_value is not None:
        for y in range(HEIGHT // 3, HEIGHT):
            for x in range(WIDTH // 4, WIDTH):
                pixels[y * WIDTH + x] = (occlusion_value + (x * 3 + y * 5) % 9) % 256
    return GrayFrame(index * 125, bytes(pixels))


def patch_frame(index: int, patch_value: int | None, size: int) -> GrayFrame:
    pixels = bytearray((x + y * 2) % 64 for y in range(HEIGHT) for x in range(WIDTH))
    if patch_value is not None:
        for y in range(HEIGHT // 2, HEIGHT // 2 + size):
            for x in range(WIDTH // 2, WIDTH // 2 + size):
                pixels[y * WIDTH + x] = (patch_value + (x * 3 + y * 5) % 9) % 256
    return GrayFrame(index * 125, bytes(pixels))


class NearCameraActivityTests(unittest.TestCase):
    def test_requires_two_qualifying_samples_within_four_transitions(self) -> None:
        detector = NearCameraActivityDetector(WIDTH, HEIGHT)
        frames = [textured_frame(0)]
        frames += [textured_frame(index, 1 if index in {2, 4} else 0) for index in range(1, 6)]
        for previous, current in pairwise(frames):
            detector.observe(current.timestamp_ms, previous.pixels, current.pixels)

        self.assertIsNotNone(detector.candidate)
        self.assertGreaterEqual(detector.qualifying_samples, 2)
        assert detector.candidate is not None
        self.assertGreaterEqual(detector.candidate.near_camera_score, 0.7)

    def test_rejects_uniform_brightness_change(self) -> None:
        detector = NearCameraActivityDetector(WIDTH, HEIGHT)
        detector.observe(125, bytes([60]) * (WIDTH * HEIGHT), bytes([140]) * (WIDTH * HEIGHT))

        self.assertIsNone(detector.candidate)
        self.assertEqual(detector.best_sample.gradient_change_ratio, 0.0)
        self.assertEqual(detector.best_sample.near_camera_score, 0.0)

    def test_camera_analysis_emits_activity_and_fail_closed_statuses(self) -> None:
        frames = [patch_frame(index, None, 40) for index in range(32)]
        frames[12] = patch_frame(12, 80, 40)
        frames[13] = patch_frame(13, 160, 40)
        frames[14] = patch_frame(14, 80, 40)

        activity = analyze_camera_frames("back", "back-001", frames)
        insufficient = analyze_camera_frames("front", "front-001", frames[:23])

        self.assertEqual(activity.status, "activity_detected")
        self.assertIsNotNone(activity.candidate_timestamp_ms)
        self.assertEqual(insufficient.status, "indeterminate")
        self.assertEqual(insufficient.issues, ("insufficient_frames",))

    def test_static_frames_emit_no_activity_signal(self) -> None:
        result = analyze_camera_frames(
            "right_pillar",
            "right-pillar-001",
            (textured_frame(index) for index in range(32)),
        )

        self.assertEqual(result.status, "no_activity_signal_observed")
        self.assertIsNone(result.candidate_timestamp_ms)
        self.assertIsNotNone(result.metrics)

    def test_flat_occlusion_transition_reports_high_flat_ratio(self) -> None:
        sample = measure_near_camera_change(
            125, occluded_frame(0, None).pixels, occluded_frame(1, 96).pixels, WIDTH, HEIGHT
        )

        self.assertGreaterEqual(sample.flat_ratio, 0.40)
        self.assertLessEqual(sample.bbox_ratio, 0.85)
        self.assertGreaterEqual(sample.occlusion_score, 0.50)

    def test_uniform_brightness_change_is_not_occlusion(self) -> None:
        sample = measure_near_camera_change(
            125, bytes([60]) * (WIDTH * HEIGHT), bytes([140]) * (WIDTH * HEIGHT), WIDTH, HEIGHT
        )

        self.assertEqual(sample.occlusion_score, 0.0)

    def test_occlusion_channel_detects_sustained_covering_without_motion_channel(self) -> None:
        detector = NearCameraActivityDetector(WIDTH, HEIGHT)
        frames = [
            occluded_frame(index, 70 if index % 2 == 0 else 150 if 3 <= index <= 8 else None)
            for index in range(32)
        ]
        for previous, current in pairwise(frames):
            detector.observe(current.timestamp_ms, previous.pixels, current.pixels)

        self.assertIsNotNone(detector.occlusion_candidate)
        self.assertGreaterEqual(detector.occlusion_qualifying_samples, 2)
        self.assertIsNone(detector.candidate)

    def test_camera_analysis_reports_occlusion_metrics(self) -> None:
        frames = [
            occluded_frame(index, 70 if index % 2 == 0 else 150 if 5 <= index <= 8 else None)
            for index in range(32)
        ]

        result = analyze_camera_frames("back", "back-occl", frames)

        self.assertEqual(result.status, "activity_detected")
        assert result.metrics is not None
        self.assertGreaterEqual(result.metrics.occlusion_qualifying_samples, 2)
        self.assertGreaterEqual(result.metrics.occlusion_flat_ratio, 0.40)
        self.assertLess(result.metrics.near_camera_score, 0.70)

    def test_single_occlusion_transition_is_not_activity(self) -> None:
        frames = [occluded_frame(index, 96 if index >= 5 else None) for index in range(32)]

        result = analyze_camera_frames("back", "back-brief", frames)

        self.assertEqual(result.status, "no_activity_signal_observed")
        assert result.metrics is not None
        self.assertEqual(result.metrics.occlusion_qualifying_samples, 1)

    def test_mid_distance_occlusion_without_proximity_is_not_activity(self) -> None:
        frames = [patch_frame(index, None, 32) for index in range(32)]
        frames[10] = patch_frame(10, 80, 32)
        frames[11] = patch_frame(11, 160, 32)
        frames[12] = patch_frame(12, 80, 32)

        result = analyze_camera_frames("front", "front-mid", frames)

        self.assertEqual(result.status, "no_activity_signal_observed")
        assert result.metrics is not None
        self.assertGreaterEqual(result.metrics.occlusion_qualifying_samples, 2)
        self.assertLess(result.metrics.occlusion_score, 1.0)

    def test_self_motion_without_occlusion_support_is_not_activity(self) -> None:
        frames = [textured_frame(index) for index in range(32)]
        frames[12] = textured_frame(12, 1)
        frames[13] = textured_frame(13, 2)

        result = analyze_camera_frames("front", "front-self-motion", frames)

        self.assertEqual(result.status, "no_activity_signal_observed")
        assert result.metrics is not None
        self.assertGreaterEqual(result.metrics.qualifying_samples, 2)
        self.assertEqual(result.metrics.occlusion_qualifying_samples, 0)

    def test_dual_channel_candidate_remains_activity(self) -> None:
        frames = [patch_frame(index, None, 40) for index in range(32)]
        frames[10] = patch_frame(10, 80, 40)
        frames[11] = patch_frame(11, 160, 40)
        frames[12] = patch_frame(12, 80, 40)
        frames[13] = textured_frame(13)
        frames[14] = textured_frame(14, 1)

        result = analyze_camera_frames("back", "back-dual", frames)

        self.assertEqual(result.status, "activity_detected")
        self.assertIsNotNone(result.candidate_timestamp_ms)


if __name__ == "__main__":
    unittest.main()
