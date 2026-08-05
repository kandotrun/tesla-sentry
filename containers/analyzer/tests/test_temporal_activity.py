from __future__ import annotations

import unittest
from collections.abc import Iterator

from sentry_analyzer.temporal_activity import (
    GrayFrame,
    TemporalAnalysisConfig,
    analyze_temporal_frames,
)


def ignore_transition(timestamp_ms: int, previous: bytes, current: bytes) -> None:
    _ = timestamp_ms, previous, current


class TemporalActivityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = TemporalAnalysisConfig(
            frame_height=2,
            frame_width=3,
            maximum_interval_ms=250,
            minimum_contrast=0.0,
            minimum_frames=3,
            minimum_interval_ms=62,
        )

    def test_streams_valid_transitions_once_and_reports_duration(self) -> None:
        consumed = [0, 0, 0]
        transitions: list[tuple[int, bytes, bytes]] = []

        def frames() -> Iterator[GrayFrame]:
            for index in range(3):
                consumed[index] += 1
                yield GrayFrame(index * 125, bytes([index]) * 6)

        summary = analyze_temporal_frames(
            frames(),
            self.config,
            lambda timestamp, previous, current: transitions.append((timestamp, previous, current)),
        )

        self.assertEqual(consumed, [1, 1, 1])
        self.assertEqual([item[0] for item in transitions], [125, 250])
        self.assertEqual((summary.analyzed_frames, summary.duration_ms), (3, 250))
        self.assertEqual(summary.issues, ())

    def test_reports_invalid_pixels_and_timing_in_fixed_order(self) -> None:
        frames = (
            GrayFrame(0, bytes(6)),
            GrayFrame(61, b"invalid"),
            GrayFrame(122, bytes(6)),
        )

        summary = analyze_temporal_frames(frames, self.config, ignore_transition)

        self.assertEqual(summary.issues, ("unsupported_video", "frame_timing_unreliable"))

    def test_rejects_invalid_configuration(self) -> None:
        with self.assertRaises(ValueError):
            TemporalAnalysisConfig(0, 3, 250, 0.0, 3, 62)


if __name__ == "__main__":
    unittest.main()
