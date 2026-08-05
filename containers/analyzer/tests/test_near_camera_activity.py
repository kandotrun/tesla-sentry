from __future__ import annotations

import unittest
from itertools import pairwise

from sentry_analyzer.camera_activity import analyze_camera_frames
from sentry_analyzer.near_camera_activity import NearCameraActivityDetector
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
        frames = [textured_frame(index) for index in range(32)]
        frames[12] = textured_frame(12, 1)
        frames[13] = textured_frame(13, 2)

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


if __name__ == "__main__":
    unittest.main()
