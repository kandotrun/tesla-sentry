from __future__ import annotations

import json
import math
import unittest
from dataclasses import replace

from sentry_analyzer.camera_activity import (
    CAMERA_ACTIVITY_ORDER,
    CameraActivityEventResult,
    CameraActivityMetrics,
    CameraActivityResult,
    CameraActivityResultError,
    CameraActivityStatus,
    KnownCamera,
    aggregate_camera_activity,
)


def metrics(score: float = 0.75, qualifying: int = 2) -> CameraActivityMetrics:
    return CameraActivityMetrics(0.06, 0.08, score, qualifying)


def direction(
    camera: KnownCamera,
    status: CameraActivityStatus = "no_activity_signal_observed",
) -> CameraActivityResult:
    if status == "activity_detected":
        return CameraActivityResult(
            4_000, 32, camera, 1_500, f"{camera}-001", (), metrics(), status
        )
    if status == "indeterminate":
        return CameraActivityResult(
            0,
            0,
            camera,
            None,
            f"{camera}-001",
            ("decode_failed",),
            None,
            status,
        )
    return CameraActivityResult(
        4_000, 32, camera, None, f"{camera}-001", (), metrics(0.3, 0), status
    )


class CameraActivitySchemaTests(unittest.TestCase):
    def test_serializes_exact_direction_status_payloads(self) -> None:
        cases = (
            direction("front", "activity_detected"),
            direction("front"),
            direction("front", "indeterminate"),
        )
        for result in cases:
            with self.subTest(status=result.status):
                payload = result.to_dict()
                self.assertEqual(
                    tuple(payload),
                    (
                        "analysisDurationMs",
                        "analyzedFrames",
                        "analyzerVersion",
                        "camera",
                        "candidateTimestampMs",
                        "clipId",
                        "issues",
                        "metrics",
                        "schemaVersion",
                        "source",
                        "status",
                    ),
                )
                if payload["metrics"] is not None:
                    self.assertEqual(
                        tuple(payload["metrics"]),
                        (
                            "changedPixelRatio",
                            "gradientChangeRatio",
                            "nearCameraScore",
                            "qualifyingSamples",
                        ),
                    )
                json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    def test_aggregate_status_precedence_and_exact_order(self) -> None:
        all_clear = tuple(direction(camera) for camera in CAMERA_ACTIVITY_ORDER)
        indeterminate = tuple(
            direction(camera, "indeterminate") if camera == "back" else direction(camera)
            for camera in CAMERA_ACTIVITY_ORDER
        )
        activity = tuple(
            direction(camera, "activity_detected")
            if camera == "front"
            else direction(camera, "indeterminate")
            if camera == "back"
            else direction(camera)
            for camera in CAMERA_ACTIVITY_ORDER
        )
        cases = (
            (all_clear, "no_activity_signal_observed"),
            (indeterminate, "indeterminate"),
            (activity, "activity_detected"),
        )
        for cameras, expected in cases:
            with self.subTest(expected=expected):
                result = aggregate_camera_activity("event-001", cameras)
                self.assertEqual(result.status, expected)
                payload = result.to_dict()
                self.assertEqual(
                    tuple(payload),
                    ("analyzerVersion", "cameras", "eventId", "schemaVersion", "source", "status"),
                )
                self.assertEqual(
                    tuple(item["camera"] for item in payload["cameras"]),
                    CAMERA_ACTIVITY_ORDER,
                )

    def test_rejects_invalid_camera_set(self) -> None:
        valid = tuple(direction(camera) for camera in CAMERA_ACTIVITY_ORDER)
        invalid = (
            valid[:-1],
            (*valid[:-1], valid[-2]),
            (valid[1], valid[0], *valid[2:]),
        )
        for cameras in invalid:
            with self.subTest(cameras=len(cameras)), self.assertRaises(CameraActivityResultError):
                CameraActivityEventResult("event-001", cameras, "no_activity_signal_observed")

    def test_rejects_invalid_fields_and_status_combinations(self) -> None:
        active = direction("front", "activity_detected")
        invalid = (
            lambda: replace(active, candidate_timestamp_ms=None),
            lambda: replace(active, metrics=None),
            lambda: replace(active, issues=("low_visibility",)),
            lambda: replace(active, camera="unknown"),
            lambda: replace(active, clip_id="../private"),
            lambda: replace(active, analysis_duration_ms=2**53),
            lambda: replace(active, metrics=metrics(math.nan)),
            lambda: replace(active, metrics=metrics(math.inf)),
            lambda: replace(active, metrics=CameraActivityMetrics(0.5, 0.5, 0.5, -1)),
        )
        for build in invalid:
            with self.subTest(build=build), self.assertRaises(CameraActivityResultError):
                build()


if __name__ == "__main__":
    unittest.main()
