from __future__ import annotations

import json
import unittest
from pathlib import Path

from sentry_analyzer.camera_activity import (
    CAMERA_ACTIVITY_ORDER,
    CameraActivityMetrics,
    CameraActivityResult,
    aggregate_camera_activity,
)


class CameraActivityFixtureTests(unittest.TestCase):
    def test_python_serializer_matches_cross_language_fixture_bytes(self) -> None:
        cameras = tuple(
            CameraActivityResult(
                4_000,
                32,
                camera,
                1_500 if camera == "back" else None,
                f"{camera}-001",
                (),
                CameraActivityMetrics(
                    0.06 if camera == "back" else 0.02,
                    0.08 if camera == "back" else 0.03,
                    0.75 if camera == "back" else 0.25,
                    2 if camera == "back" else 0,
                    0.55 if camera == "back" else 0.0,
                    2 if camera == "back" else 0,
                    0.75 if camera == "back" else 0.25,
                ),
                "activity_detected" if camera == "back" else "no_activity_signal_observed",
            )
            for camera in CAMERA_ACTIVITY_ORDER
        )
        result = aggregate_camera_activity("event-001", cameras)
        serialized = json.dumps(result.to_dict(), ensure_ascii=False, separators=(",", ":")) + "\n"
        fixture = (
            Path(__file__).resolve().parents[3]
            / "packages/camera-geometry/tests/fixtures/camera-temporal-activity-v3.json"
        )

        self.assertEqual(serialized.encode(), fixture.read_bytes())


if __name__ == "__main__":
    unittest.main()
