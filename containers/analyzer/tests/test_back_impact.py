from __future__ import annotations

import math
import unittest
from collections.abc import Iterator
from dataclasses import replace

import sentry_analyzer.back_impact as back_impact
from sentry_analyzer.back_impact import (
    ANALYZER_VERSION,
    FRAME_HEIGHT,
    FRAME_WIDTH,
    BackImpactMetrics,
    BackImpactResult,
    GrayFrame,
    analyze_back_frames,
)


def pattern_frame(
    index: int,
    shift_x: int = 0,
    shift_y: int = 0,
    brightness: int = 0,
) -> GrayFrame:
    pixels = bytearray(FRAME_WIDTH * FRAME_HEIGHT)
    for y in range(FRAME_HEIGHT):
        for x in range(FRAME_WIDTH):
            source_x = x - shift_x
            source_y = y - shift_y
            value = ((source_x // 8 + source_y // 8) % 2) * 120 + 60 + brightness
            pixels[y * FRAME_WIDTH + x] = max(0, min(255, value))
    return GrayFrame(timestamp_ms=index * 125, pixels=bytes(pixels))


def frames_for_shifts(shifts: list[int]) -> tuple[GrayFrame, ...]:
    return tuple(pattern_frame(index, shift_x=shift) for index, shift in enumerate(shifts))


def frames_for_offsets(offsets: list[tuple[int, int]]) -> tuple[GrayFrame, ...]:
    return tuple(
        pattern_frame(index, shift_x=shift_x, shift_y=shift_y)
        for index, (shift_x, shift_y) in enumerate(offsets)
    )


class BackImpactSignalTests(unittest.TestCase):
    def test_marks_abrupt_translation_and_recovery_as_possible_contact(self) -> None:
        shifts = [0] * 12 + [3, 3, 0] + [0] * 17

        result = analyze_back_frames("back-001", frames_for_shifts(shifts))

        self.assertEqual(result.status, "possible_contact")
        self.assertEqual(result.candidate_timestamp_ms, 1_500)
        self.assertIsNotNone(result.metrics)

    def test_keeps_static_frames_as_no_impact_signal(self) -> None:
        frames = tuple(pattern_frame(index) for index in range(32))

        result = analyze_back_frames("back-001", frames)

        self.assertEqual(result.status, "no_impact_signal_observed")
        self.assertIsNone(result.candidate_timestamp_ms)

    def test_selects_strongest_candidate_instead_of_latest(self) -> None:
        offsets = [(0, 0)] * 12 + [(3, 3), (3, 3)] + [(0, 0)] * 14
        offsets += [(3, 0), (3, 0)] + [(0, 0)] * 10

        result = analyze_back_frames("back-001", frames_for_offsets(offsets))

        self.assertEqual(result.candidate_timestamp_ms, 1_500)
        self.assertIsNotNone(result.metrics)
        assert result.metrics is not None
        self.assertGreater(result.metrics.global_motion_score, 0.7)

    def test_keeps_earliest_candidate_when_global_motion_scores_tie(self) -> None:
        offsets = [(0, 0)] * 12 + [(3, 0), (3, 0)] + [(0, 0)] * 14
        offsets += [(3, 0), (3, 0)] + [(0, 0)] * 10

        result = analyze_back_frames("back-001", frames_for_offsets(offsets))

        self.assertEqual(result.candidate_timestamp_ms, 1_500)

    def test_keeps_smooth_one_way_motion_as_no_impact_signal(self) -> None:
        shifts = [min(index // 4, 3) for index in range(32)]

        result = analyze_back_frames("back-001", frames_for_shifts(shifts))

        self.assertEqual(result.status, "no_impact_signal_observed")

    def test_rejects_whole_frame_brightness_flash_as_impact_signal(self) -> None:
        frames = tuple(
            pattern_frame(index, brightness=50 if index == 14 else 0) for index in range(32)
        )

        result = analyze_back_frames("back-001", frames)

        self.assertEqual(result.status, "no_impact_signal_observed")

    def test_requires_short_recovery_after_abrupt_translation(self) -> None:
        shifts = [0] * 12 + [3] * 20

        result = analyze_back_frames("back-001", frames_for_shifts(shifts))

        self.assertEqual(result.status, "no_impact_signal_observed")

    def test_marks_reversed_timestamp_as_indeterminate(self) -> None:
        frames = [pattern_frame(index) for index in range(32)]
        frames[15] = GrayFrame(timestamp_ms=frames[14].timestamp_ms, pixels=frames[15].pixels)

        result = analyze_back_frames("back-001", frames)

        self.assertEqual(result.status, "indeterminate")
        self.assertEqual(result.issues, ("frame_timing_unreliable",))

    def test_marks_fewer_than_twenty_four_frames_as_indeterminate(self) -> None:
        frames = tuple(pattern_frame(index) for index in range(23))

        result = analyze_back_frames("back-001", frames)

        self.assertEqual(result.status, "indeterminate")
        self.assertEqual(result.issues, ("insufficient_frames",))

    def test_marks_invalid_pixel_byte_length_as_indeterminate(self) -> None:
        frames = [pattern_frame(index) for index in range(32)]
        frames[10] = GrayFrame(timestamp_ms=1_250, pixels=b"invalid")

        result = analyze_back_frames("back-001", frames)

        self.assertEqual(result.status, "indeterminate")
        self.assertEqual(result.issues, ("unsupported_video",))

    def test_excludes_first_and_last_decode_boundaries_from_candidates(self) -> None:
        boundary_offsets = (
            [(3, 0), (3, 0)] + [(0, 0)] * 30,
            [(0, 0)] * 29 + [(3, 0), (3, 0), (0, 0)],
        )
        for offsets in boundary_offsets:
            with self.subTest(offsets=offsets[:3]):
                result = analyze_back_frames("back-001", frames_for_offsets(offsets))
                self.assertEqual(result.status, "no_impact_signal_observed")

    def test_applies_closed_frame_interval_boundaries(self) -> None:
        cases = (
            (62, "no_impact_signal_observed", ()),
            (250, "no_impact_signal_observed", ()),
            (61, "indeterminate", ("frame_timing_unreliable",)),
            (251, "indeterminate", ("frame_timing_unreliable",)),
        )
        for interval, expected_status, expected_issues in cases:
            with self.subTest(interval=interval):
                frames = tuple(
                    replace(pattern_frame(index), timestamp_ms=index * interval)
                    for index in range(32)
                )
                result = analyze_back_frames("back-001", frames)
                self.assertEqual((result.status, result.issues), (expected_status, expected_issues))

    def test_orders_multiple_issues_deterministically(self) -> None:
        low_pixels = bytes([90]) * (FRAME_WIDTH * FRAME_HEIGHT)
        frames = [GrayFrame(index * 61, low_pixels) for index in range(23)]
        frames[10] = GrayFrame(610, b"invalid")

        result = analyze_back_frames("back-001", frames)

        self.assertEqual(
            result.issues,
            (
                "unsupported_video",
                "insufficient_frames",
                "frame_timing_unreliable",
                "low_visibility",
            ),
        )

    def test_consumes_each_generated_frame_once(self) -> None:
        yields = [0] * 32

        def generated_frames() -> Iterator[GrayFrame]:
            for index in range(32):
                yields[index] += 1
                yield pattern_frame(index)

        analyze_back_frames("back-001", generated_frames())

        self.assertEqual(yields, [1] * 32)

    def test_applies_half_low_contrast_boundary(self) -> None:
        low_pixels = bytes([90]) * (FRAME_WIDTH * FRAME_HEIGHT)
        for low_count, expected_low_visibility in ((16, True), (15, False)):
            with self.subTest(low_count=low_count):
                frames = tuple(
                    GrayFrame(index * 125, low_pixels)
                    if index < low_count
                    else pattern_frame(index)
                    for index in range(32)
                )
                result = analyze_back_frames("back-001", frames)
                self.assertEqual("low_visibility" in result.issues, expected_low_visibility)
                if expected_low_visibility:
                    self.assertEqual((result.status, result.metrics), ("indeterminate", None))

    def test_keeps_scores_finite_and_normalized(self) -> None:
        shifts = [0] * 12 + [3, 3, 0] + [0] * 17

        metrics = analyze_back_frames("back-001", frames_for_shifts(shifts)).metrics

        self.assertIsNotNone(metrics)
        assert metrics is not None
        for score in (
            metrics.global_motion_score,
            metrics.impulse_score,
            metrics.recovery_score,
        ):
            self.assertTrue(math.isfinite(score) and 0.0 <= score <= 1.0)

    def test_serializes_exact_payload_for_each_valid_status(self) -> None:
        metrics = BackImpactMetrics(0.12345649, 0.65432149, 1.0)
        rounded_metrics = {
            "globalMotionScore": 0.123456,
            "impulseScore": 0.654321,
            "recoveryScore": 1.0,
        }
        cases = (
            (
                BackImpactResult(4_000, 32, 2_000, "back-001", (), metrics, "possible_contact"),
                2_000,
                (),
                rounded_metrics,
            ),
            (
                BackImpactResult(
                    4_000, 32, None, "back-001", (), metrics, "no_impact_signal_observed"
                ),
                None,
                (),
                rounded_metrics,
            ),
            (
                BackImpactResult(
                    4_000, 32, None, "back-001", ("low_visibility",), None, "indeterminate"
                ),
                None,
                ("low_visibility",),
                None,
            ),
        )
        for result, expected_candidate, expected_issues, expected_metrics in cases:
            with self.subTest(status=result.status):
                payload = result.to_dict()
                self.assertEqual(len(payload), 11)
                self.assertEqual(payload["analysisDurationMs"], 4_000)
                self.assertEqual(payload["analyzedFrames"], 32)
                self.assertEqual(payload["analyzerVersion"], ANALYZER_VERSION)
                self.assertEqual(payload["camera"], "back")
                self.assertEqual(payload["candidateTimestampMs"], expected_candidate)
                self.assertEqual(payload["clipId"], "back-001")
                self.assertEqual(tuple(payload["issues"]), expected_issues)
                self.assertEqual(payload["metrics"], expected_metrics)
                self.assertEqual(payload["schemaVersion"], 1)
                self.assertEqual(payload["source"], "back_temporal_motion")
                self.assertEqual(payload["status"], result.status)
        for clip_id in ("a", "a" * 128):
            with self.subTest(clip_id=clip_id):
                self.assertEqual(replace(cases[0][0], clip_id=clip_id).to_dict()["clipId"], clip_id)

    def test_rejects_invalid_public_result_states(self) -> None:
        metrics = BackImpactMetrics(0.5, 0.5, 0.5)
        possible = BackImpactResult(4_000, 32, 2_000, "back-001", (), metrics, "possible_contact")
        no_impact = BackImpactResult(
            4_000, 32, None, "back-001", (), metrics, "no_impact_signal_observed"
        )
        indeterminate = BackImpactResult(
            4_000, 32, None, "back-001", ("low_visibility",), None, "indeterminate"
        )
        invalid_results = (
            lambda: replace(possible, candidate_timestamp_ms=None),
            lambda: replace(possible, metrics=None),
            lambda: replace(possible, issues=("low_visibility",)),
            lambda: replace(indeterminate, issues=()),
            lambda: replace(indeterminate, metrics=metrics),
            lambda: replace(indeterminate, candidate_timestamp_ms=1),
            lambda: replace(no_impact, candidate_timestamp_ms=1),
            lambda: replace(no_impact, issues=("low_visibility",)),
            lambda: replace(no_impact, metrics=None),
            lambda: replace(possible, candidate_timestamp_ms=-1),
            lambda: replace(possible, candidate_timestamp_ms=4_001),
            lambda: replace(possible, analysis_duration_ms=-1),
            lambda: replace(possible, analysis_duration_ms=2**53),
            lambda: replace(possible, analyzed_frames=-1),
            lambda: replace(possible, analyzed_frames=2**53),
        )
        invalid_results += tuple(
            lambda score=score: replace(possible, metrics=BackImpactMetrics(score, 0.5, 0.5))
            for score in (math.nan, math.inf, -math.inf, -0.01, 1.01)
        )
        invalid_results += tuple(
            lambda clip_id=clip_id: replace(possible, clip_id=clip_id)
            for clip_id in ("", "-back", "back/001", "back 001", "a" * 129)
        )
        invalid_results += (lambda: replace(indeterminate, **{"issues": ("unknown_issue",)}),)
        for build in invalid_results:
            with self.subTest(build=build), self.assertRaises(back_impact.BackImpactResultError):
                build()
