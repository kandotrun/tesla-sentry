from __future__ import annotations

import json
import unittest
from typing import Final

from sentry_analyzer.back_impact_probe import (
    JsonValue,
    MediaIssue,
    parse_probe_payload,
    parse_sps_trace,
    probe_is_supported,
)

SUPPORTED_FRAME: Final = """{"width":1456,"height":944,"crop_top":0,
"crop_bottom":6,"crop_left":0,"crop_right":8}"""
PROBE_TEMPLATE: Final = """{"streams":[{"codec_name":"h264","width":1448,
"height":938,"coded_width":1456,"coded_height":944,"avg_frame_rate":"8/1",
"duration":"4"}],"frames":__FRAMES__,"format":{"duration":"4"},
"programs":[],"stream_groups":[]}"""
SPS_FIELDS: Final = (
    ("chroma_format_idc", 1),
    ("frame_cropping_flag", 1),
    ("frame_crop_left_offset", 0),
    ("frame_crop_right_offset", 4),
    ("frame_crop_top_offset", 0),
    ("frame_crop_bottom_offset", 3),
)


def sps_trace() -> bytes:
    return "\n".join(f"[trace_headers] 1 {name} 1 = {value}" for name, value in SPS_FIELDS).encode()


def malformed_sps_line(name: str) -> bytes:
    return f"[trace_headers] 1 {name} 1 = x".encode()


def probe_payload(
    frames: str = f"[{SUPPORTED_FRAME}]", template: str = PROBE_TEMPLATE
) -> JsonValue:
    payload: JsonValue = json.loads(template.replace("__FRAMES__", frames))
    return payload


class BackImpactSpsCompatibilityTests(unittest.TestCase):
    def test_identical_complete_sps_repetition_is_idempotent(self) -> None:
        repeated = b"\n".join((sps_trace(), sps_trace()))

        crop = parse_sps_trace(repeated)

        self.assertEqual(crop, (0, 6, 0, 8))

    def test_conflicting_repeated_sps_value_is_rejected(self) -> None:
        conflict = sps_trace().replace(
            b"frame_crop_right_offset 1 = 4", b"frame_crop_right_offset 1 = 5"
        )

        with self.assertRaises(MediaIssue):
            parse_sps_trace(b"\n".join((sps_trace(), conflict)))

    def test_incomplete_repeated_sps_count_is_rejected(self) -> None:
        incomplete = b"\n".join(sps_trace().splitlines()[:-1])

        with self.assertRaises(MediaIssue):
            parse_sps_trace(b"\n".join((sps_trace(), incomplete)))

    def test_invalid_sps_shapes_remain_rejected(self) -> None:
        trace = sps_trace()
        invalid = (
            b"",
            b"\n".join(trace.splitlines()[:-1]),
            trace.replace(b"frame_crop_left_offset 1 = 0", b"frame_crop_left_offset 1 = x"),
            trace.replace(b"frame_crop_left_offset 1 = 0", b"frame_crop_left_offset 1 = -1"),
            trace.replace(b"chroma_format_idc 1 = 1", b"chroma_format_idc 1 = 2"),
            trace.replace(b"frame_cropping_flag 1 = 1", b"frame_cropping_flag 1 = 0"),
            b"\xff",
            b"x" * (1024 * 1024 + 1),
        )

        for raw in invalid:
            with self.subTest(size=len(raw)), self.assertRaises(MediaIssue):
                parse_sps_trace(raw)

    def test_valid_sps_followed_by_each_malformed_required_field_is_rejected(self) -> None:
        for name, _ in SPS_FIELDS:
            with self.subTest(field=name), self.assertRaises(MediaIssue):
                parse_sps_trace(b"\n".join((sps_trace(), malformed_sps_line(name))))

    def test_valid_sps_followed_by_malformed_complete_block_is_rejected(self) -> None:
        malformed = b"\n".join(malformed_sps_line(name) for name, _ in SPS_FIELDS)

        with self.assertRaises(MediaIssue):
            parse_sps_trace(b"\n".join((sps_trace(), malformed)))

    def test_required_field_identity_mismatch_is_rejected(self) -> None:
        malformed = b"[trace_headers] 1 frame_crop_left_offset_extra 1 = 0"

        with self.assertRaises(MediaIssue):
            parse_sps_trace(b"\n".join((sps_trace(), malformed)))

    def test_unrelated_trace_line_is_ignored(self) -> None:
        unrelated = b"[trace_headers] 1 pic_order_cnt_type 1 = 0"

        self.assertEqual(parse_sps_trace(b"\n".join((sps_trace(), unrelated))), (0, 6, 0, 8))


class BackImpactFrameCompatibilityTests(unittest.TestCase):
    def test_one_frame_may_omit_empty_side_data(self) -> None:
        metadata = parse_probe_payload(probe_payload(), (0, 6, 0, 8))

        self.assertEqual(metadata.crop, (0, 6, 0, 8))

    def test_zero_frames_use_complete_sps_crop(self) -> None:
        metadata = parse_probe_payload(probe_payload("[]"), (0, 6, 0, 8))

        self.assertEqual(metadata.crop, (0, 6, 0, 8))

    def test_present_invalid_side_data_is_rejected(self) -> None:
        invalid_frames = (
            f'[{SUPPORTED_FRAME[:-1]},"side_data_list":null}}]',
            f'[{SUPPORTED_FRAME[:-1]},"side_data_list":[1]}}]',
            f'[{SUPPORTED_FRAME[:-1]},"side_data_list":[{{"unexpected":1}}]}}]',
        )

        for frames in invalid_frames:
            with self.subTest(frames=frames), self.assertRaises(MediaIssue):
                parse_probe_payload(probe_payload(frames), (0, 6, 0, 8))

    def test_zero_frames_without_sps_are_rejected(self) -> None:
        with self.assertRaises(MediaIssue):
            parse_probe_payload(probe_payload("[]"))

    def test_two_frames_are_rejected(self) -> None:
        with self.assertRaises(MediaIssue):
            parse_probe_payload(
                probe_payload(f"[{SUPPORTED_FRAME},{SUPPORTED_FRAME}]"),
                (0, 6, 0, 8),
            )

    def test_frame_crop_must_match_sps_crop(self) -> None:
        with self.assertRaises(MediaIssue):
            parse_probe_payload(probe_payload(), (0, 6, 0, 10))

    def test_coded_display_crop_equation_must_match(self) -> None:
        mismatched = PROBE_TEMPLATE.replace('"width":1448', '"width":1447')

        with self.assertRaises(MediaIssue):
            parse_probe_payload(probe_payload(template=mismatched), (0, 6, 0, 8))

    def test_duration_fps_and_crop_support_gates_remain_strict(self) -> None:
        short = PROBE_TEMPLATE.replace('"duration":"4"', '"duration":"2"')
        zero_rate = PROBE_TEMPLATE.replace('"avg_frame_rate":"8/1"', '"avg_frame_rate":"0/0"')
        noncanonical = PROBE_TEMPLATE.replace('"width":1448', '"width":1446')

        self.assertFalse(
            probe_is_supported(parse_probe_payload(probe_payload(template=short), (0, 6, 0, 8)))
        )
        with self.assertRaises(MediaIssue):
            parse_probe_payload(probe_payload(template=zero_rate), (0, 6, 0, 8))
        self.assertFalse(
            probe_is_supported(
                parse_probe_payload(probe_payload("[]", noncanonical), (0, 6, 0, 10))
            )
        )

    def test_invalid_duration_metadata_is_not_rescued(self) -> None:
        zero_stream = PROBE_TEMPLATE.replace('"duration":"4"', '"duration":"0"', 1)
        missing_stream = PROBE_TEMPLATE.replace('"duration":"4"', '"duration":null', 1)
        unavailable_format = missing_stream.replace('"duration":"4"', '"duration":"N/A"')

        self.assertFalse(
            probe_is_supported(
                parse_probe_payload(probe_payload(template=zero_stream), (0, 6, 0, 8))
            )
        )
        with self.assertRaises(MediaIssue):
            parse_probe_payload(probe_payload(template=unavailable_format), (0, 6, 0, 8))


if __name__ == "__main__":
    unittest.main()
