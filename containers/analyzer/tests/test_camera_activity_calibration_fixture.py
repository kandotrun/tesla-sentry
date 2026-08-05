from __future__ import annotations

import json
import unittest
from pathlib import Path

from sentry_analyzer.back_impact_probe import JsonValue
from sentry_analyzer.camera_activity import CAMERA_ACTIVITY_ORDER


class CameraActivityCalibrationFixtureTests(unittest.TestCase):
    def test_fixture_records_denominators_and_six_camera_result_without_private_metadata(
        self,
    ) -> None:
        fixture = Path(__file__).parent / "fixtures/camera-temporal-activity-calibration-v1.json"
        payload: JsonValue = json.loads(fixture.read_text())
        if not isinstance(payload, dict):
            self.fail("fixture must be a mapping")
        self.assertEqual(payload["confirmedTouchWindows"], {"detected": 1, "total": 1})
        self.assertEqual(payload["comparisonWindows"], {"detected": 0, "total": 7})
        self.assertIs(payload["independentBlindHoldout"], False)
        synchronized = payload["synchronizedConfirmedWindow"]
        if not isinstance(synchronized, list):
            self.fail("synchronized result must be a list")
        cameras: list[str] = []
        qualifying: list[str] = []
        for item in synchronized:
            if not isinstance(item, dict):
                self.fail("camera result must be a mapping")
            camera = item.get("camera")
            samples = item.get("qualifyingSamples")
            if (
                not isinstance(camera, str)
                or isinstance(samples, bool)
                or not isinstance(samples, int)
            ):
                self.fail("camera result fields are invalid")
            cameras.append(camera)
            if samples >= 2:
                qualifying.append(camera)
        self.assertEqual(tuple(cameras), CAMERA_ACTIVITY_ORDER)
        self.assertEqual(tuple(qualifying), ("back",))
        serialized = fixture.read_text()
        self.assertNotRegex(serialized, r"TeslaCam|/Users/|20\d\d-\d\d-\d\d|\.mp4")


if __name__ == "__main__":
    unittest.main()
