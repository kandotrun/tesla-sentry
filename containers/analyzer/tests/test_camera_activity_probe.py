from __future__ import annotations

import json
import unittest

from sentry_analyzer.back_impact_probe import JsonValue, MediaIssue, parse_probe_payload
from sentry_analyzer.camera_activity import CAMERA_ACTIVITY_ORDER
from sentry_analyzer.camera_activity_probe import probe_is_supported_for_camera


def payload(front: bool, frames: int = 1) -> tuple[JsonValue, tuple[int, int, int, int]]:
    if front:
        display_width, display_height = 2896, 1876
        coded_width, coded_height = 2896, 1888
        crop = (0, 12, 0, 0)
    else:
        display_width, display_height = 1448, 938
        coded_width, coded_height = 1456, 944
        crop = (0, 6, 0, 8)
    frame = {
        "width": coded_width,
        "height": coded_height,
        "crop_top": crop[0],
        "crop_bottom": crop[1],
        "crop_left": crop[2],
        "crop_right": crop[3],
    }
    raw = {
        "streams": [
            {
                "codec_name": "h264",
                "width": display_width,
                "height": display_height,
                "coded_width": coded_width,
                "coded_height": coded_height,
                "avg_frame_rate": "8/1",
                "duration": "4",
            }
        ],
        "frames": [frame] * frames,
        "format": {"duration": "4"},
        "programs": [],
        "stream_groups": [],
    }
    value: JsonValue = json.loads(json.dumps(raw))
    return value, crop


class CameraActivityProbeTests(unittest.TestCase):
    def test_accepts_front_and_standard_five_profiles_with_zero_or_one_frame(self) -> None:
        for camera in CAMERA_ACTIVITY_ORDER:
            for frame_count in (0, 1):
                with self.subTest(camera=camera, frame_count=frame_count):
                    raw, crop = payload(camera == "front", frame_count)
                    metadata = parse_probe_payload(raw, crop)
                    self.assertTrue(probe_is_supported_for_camera(camera, metadata))

    def test_rejects_profile_mismatch_and_two_frame_payload(self) -> None:
        front_raw, front_crop = payload(True)
        standard_raw, standard_crop = payload(False)
        self.assertFalse(
            probe_is_supported_for_camera("front", parse_probe_payload(standard_raw, standard_crop))
        )
        self.assertFalse(
            probe_is_supported_for_camera("back", parse_probe_payload(front_raw, front_crop))
        )
        two_frames, crop = payload(False, 2)
        with self.assertRaises(MediaIssue):
            parse_probe_payload(two_frames, crop)

    def test_rejects_wrong_crop_codec_rotation_or_duration(self) -> None:
        raw, crop = payload(True)
        assert isinstance(raw, dict)
        streams = raw["streams"]
        assert isinstance(streams, list) and isinstance(streams[0], dict)
        base_stream = streams[0]
        variants = (
            {**base_stream, "codec_name": "hevc"},
            {**base_stream, "duration": "2"},
            {**base_stream, "tags": {"rotate": "90"}},
        )
        for stream in variants:
            with self.subTest(stream=stream):
                variant: JsonValue = json.loads(json.dumps({**raw, "streams": [stream]}))
                self.assertFalse(
                    probe_is_supported_for_camera(
                        "front",
                        parse_probe_payload(variant, crop),
                    )
                )


if __name__ == "__main__":
    unittest.main()
