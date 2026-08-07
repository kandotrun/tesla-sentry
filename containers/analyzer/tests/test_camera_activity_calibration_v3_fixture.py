from __future__ import annotations

import json
import unittest
from pathlib import Path

from sentry_analyzer.back_impact_probe import JsonValue


class CameraActivityCalibrationV3FixtureTests(unittest.TestCase):
    def test_fixture_records_v3_gates_without_private_metadata(self) -> None:
        fixture = Path(__file__).parent / "fixtures/camera-temporal-activity-calibration-v3.json"
        payload: JsonValue = json.loads(fixture.read_text())
        if not isinstance(payload, dict):
            self.fail("fixture must be a mapping")
        self.assertEqual(payload["analyzerVersion"], "camera-temporal-activity-v3")
        self.assertEqual(payload["confirmedTouchWindows"], {"detected": 1, "total": 1})
        self.assertEqual(payload["comparisonWindows"], {"detected": 0, "total": 9})
        thresholds = payload["thresholds"]
        if not isinstance(thresholds, dict):
            self.fail("thresholds must be a mapping")
        self.assertEqual(thresholds["occlusionProximityChangedRatio"], 0.08)
        self.assertIs(thresholds["motionRequiresOcclusionSupport"], True)
        windows = payload["windows"]
        if not isinstance(windows, list) or len(windows) < 10:
            self.fail("fixture must record at least ten windows")
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
                elif not name.startswith("near-miss-"):
                    comparison_activity += 1
            elif name.startswith("comparison-"):
                changed = item.get("maximumChangedPixelRatio")
                if occlusion > 0 and (not isinstance(changed, (int, float)) or changed >= 0.08):
                    self.fail("suppressed occlusion window must stay below proximity gate")
                if motion > 0 and occlusion != 0:
                    self.fail("suppressed motion window must lack occlusion support")
        self.assertEqual(confirmed, 1)
        self.assertEqual(comparison_activity, 0)
        serialized = fixture.read_text()
        self.assertNotRegex(serialized, r"TeslaCam|/Users/|20\d\d-\d\d-\d\d|\.mp4")


if __name__ == "__main__":
    unittest.main()
