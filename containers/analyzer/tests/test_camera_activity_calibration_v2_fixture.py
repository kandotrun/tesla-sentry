from __future__ import annotations

import json
import unittest
from pathlib import Path

from sentry_analyzer.back_impact_probe import JsonValue


class CameraActivityCalibrationV2FixtureTests(unittest.TestCase):
    def test_fixture_records_per_window_channel_separation_without_private_metadata(self) -> None:
        fixture = Path(__file__).parent / "fixtures/camera-temporal-activity-calibration-v2.json"
        payload: JsonValue = json.loads(fixture.read_text())
        if not isinstance(payload, dict):
            self.fail("fixture must be a mapping")
        self.assertEqual(payload["analyzerVersion"], "camera-temporal-activity-v2")
        self.assertEqual(payload["confirmedTouchWindows"], {"detected": 1, "total": 1})
        self.assertEqual(payload["comparisonWindows"], {"detected": 0, "total": 7})
        self.assertIs(payload["independentBlindHoldout"], False)
        self.assertIs(payload["synchronizedSixCameraWindowAvailable"], False)
        windows = payload["windows"]
        if not isinstance(windows, list) or len(windows) != 8:
            self.fail("fixture must record eight windows")
        confirmed = 0
        comparison_activity = 0
        for item in windows:
            if not isinstance(item, dict):
                self.fail("window result must be a mapping")
            name = item.get("window")
            status = item.get("status")
            motion = item.get("motionQualifyingSamples")
            occlusion = item.get("occlusionQualifyingSamples")
            if (
                not isinstance(name, str)
                or status not in {"activity_detected", "no_activity_signal_observed"}
                or isinstance(motion, bool)
                or not isinstance(motion, int)
                or isinstance(occlusion, bool)
                or not isinstance(occlusion, int)
            ):
                self.fail("window result fields are invalid")
            if status == "activity_detected":
                if name == "confirmed-touch":
                    confirmed += 1
                else:
                    comparison_activity += 1
        self.assertEqual(confirmed, 1)
        self.assertEqual(comparison_activity, 0)
        serialized = fixture.read_text()
        self.assertNotRegex(serialized, r"TeslaCam|/Users/|20\d\d-\d\d-\d\d|\.mp4")


if __name__ == "__main__":
    unittest.main()
