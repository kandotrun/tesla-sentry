from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from sentry_analyzer.back_impact_io import open_input
from sentry_analyzer.back_impact_media import (
    FRAME_BYTES,
    FFmpegBackImpactMedia,
)
from sentry_analyzer.back_impact_probe import (
    JsonValue,
    MediaIssue,
    parse_probe_payload,
    parse_sps_trace,
    probe_is_supported,
)

SCRIPT_ROOT = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_ROOT))

from container_smoke import JsonValue as SummaryJsonValue
from container_smoke import parse_back_summary


class BackImpactProbeTests(unittest.TestCase):
    def test_sps_trace_requires_exact_canonical_crop_fields(self) -> None:
        names = (
            "chroma_format_idc",
            "frame_cropping_flag",
            "frame_crop_left_offset",
            "frame_crop_right_offset",
            "frame_crop_top_offset",
            "frame_crop_bottom_offset",
        )
        values = (1, 1, 0, 4, 0, 3)
        lines = [
            f"[trace_headers] 1 {name} 1 = {value}"
            for name, value in zip(names, values, strict=True)
        ]
        raw = "\n".join(lines).encode()
        self.assertEqual(parse_sps_trace(raw), (0, 6, 0, 8))
        invalid = (
            b"",
            b"\n".join(raw.splitlines()[:-1]),
            raw + b"\n" + raw.splitlines()[0],
            raw.replace(b"chroma_format_idc 1 = 1", b"chroma_format_idc 1 = 2"),
            raw.replace(b"frame_cropping_flag 1 = 1", b"frame_cropping_flag 1 = 0"),
            raw.replace(b"frame_crop_left_offset 1 = 0", b"frame_crop_left_offset 1 = -1"),
            b"x" * (1024 * 1024 + 1),
        )
        for trace in invalid:
            with self.subTest(size=len(trace)), self.assertRaises(MediaIssue):
                parse_sps_trace(trace)

    def test_probe_requires_one_complete_crop_frame(self) -> None:
        valid_raw = """{"streams":[{"codec_name":"h264","width":1448,"height":938,
        "coded_width":1456,"coded_height":944,"avg_frame_rate":"8/1","duration":"4"}],
        "frames":[{"width":1456,"height":944,"crop_top":0,"crop_bottom":6,"crop_left":0,
        "crop_right":8,"side_data_list":[{}]}],
        "format":{"duration":"4"},"programs":[],"stream_groups":[]}"""
        valid: JsonValue = json.loads(valid_raw)
        self.assertEqual(parse_probe_payload(valid).crop, (0, 6, 0, 8))
        invalid_raw = (
            "{}",
            valid_raw.replace('"frames":[{', '"frames":[{"unexpected":0},{'),
            valid_raw.replace('"crop_top":0,', ""),
            valid_raw.replace('"crop_top":0', '"crop_top":"unknown"'),
            valid_raw[:-1] + ',"unexpected":true}',
        )
        for raw in invalid_raw:
            payload: JsonValue = json.loads(raw)
            with self.subTest(raw=raw), self.assertRaises(MediaIssue):
                parse_probe_payload(payload)


class BackImpactProcessTests(unittest.TestCase):
    def run_child(self, source: str) -> subprocess.Popen[bytes]:
        return subprocess.Popen(
            [sys.executable, "-c", source],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_partial_frame_is_decode_failed(self) -> None:
        process = self.run_child("import os; os.write(1, b'x' * 17)")
        media = FFmpegBackImpactMedia(deadline_seconds=2)
        with self.assertRaisesRegex(MediaIssue, "indeterminate") as raised:
            list(media.read_process(process))
        self.assertEqual(raised.exception.code, "decode_failed")
        self.assertIsNotNone(process.poll())

    def test_large_stderr_and_stdout_are_drained_without_deadlock(self) -> None:
        source = f"import os; os.write(2, b'e' * 2000000); os.write(1, b'x' * {FRAME_BYTES})"
        process = self.run_child(source)
        frames = list(FFmpegBackImpactMedia(deadline_seconds=5).read_process(process))
        self.assertEqual(
            (len(frames), len(frames[0].pixels), process.returncode), (1, FRAME_BYTES, 0)
        )

    def test_deadline_kills_and_reaps_terminate_ignoring_process(self) -> None:
        source = (
            "import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "os.write(2,b'r'); time.sleep(60)"
        )
        process = self.run_child(source)
        assert process.stderr is not None
        self.assertEqual(process.stderr.read(1), b"r")
        with self.assertRaises(MediaIssue):
            list(FFmpegBackImpactMedia(deadline_seconds=0.05).read_process(process))
        self.assertIsNotNone(process.poll())

    def test_generator_close_reaps_process(self) -> None:
        source = (
            f"import os,time\nwhile True:\n os.write(1, b'x' * {FRAME_BYTES})\n time.sleep(.01)"
        )
        process = self.run_child(source)
        stream = FFmpegBackImpactMedia(deadline_seconds=5).read_process(process)
        next(stream)
        stream.close()
        self.assertIsNotNone(process.poll())


class BackImpactFdTests(unittest.TestCase):
    def test_input_handle_is_fd_backed_and_detects_leaf_swap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = root / "input"
            input_root.mkdir()
            leaf = input_root / "back.mp4"
            leaf.write_bytes(b"original")
            with open_input(input_root, "back.mp4") as handle:
                self.assertEqual(os.pread(handle.fileno(), 8, 0), b"original")
                leaf.rename(input_root / "old.mp4")
                leaf.write_bytes(b"replacement")
                with self.assertRaises(OSError):
                    handle.verify_unchanged()


class BackImpactContainerSummaryTests(unittest.TestCase):
    def test_summary_requires_exact_keys_types_and_values(self) -> None:
        expected_raw = '{"status":"possible_contact","analyzedFrames":32,"issues":0}'
        expected: SummaryJsonValue = json.loads(expected_raw)
        self.assertEqual(
            parse_back_summary(expected),
            {"status": "possible_contact", "analyzedFrames": 32, "issues": 0},
        )
        invalid_raw = (
            expected_raw[:-1] + ',"extra":0}',
            expected_raw.replace("possible_contact", "indeterminate"),
            expected_raw.replace("32", "true"),
            expected_raw.replace("32", "31"),
            expected_raw.replace('"issues":0', '"issues":false'),
            expected_raw.replace('"issues":0', '"issues":1'),
        )
        for raw in invalid_raw:
            payload: SummaryJsonValue = json.loads(raw)
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                parse_back_summary(payload)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
class BackImpactCropFixtureTests(unittest.TestCase):
    def test_h264_metadata_crop_is_unsupported_by_cli(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            input_root = root / "input"
            input_root.mkdir()
            subprocess.run(
                [
                    "ffmpeg",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=size=1448x938:rate=8:color=black",
                    "-t",
                    "4",
                    "-c:v",
                    "libx264",
                    "-profile:v",
                    "high",
                    str(source),
                ],
                check=True,
            )
            subprocess.run(
                [
                    "ffmpeg",
                    "-loglevel",
                    "error",
                    "-i",
                    str(source),
                    "-c",
                    "copy",
                    "-bsf:v",
                    "h264_metadata=crop_left=2",
                    str(input_root / "back.mp4"),
                ],
                check=True,
            )
            probe_completed = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-f",
                    "mov",
                    "-select_streams",
                    "v:0",
                    "-apply_cropping",
                    "0",
                    "-read_intervals",
                    "%+#1",
                    "-show_optional_fields",
                    "always",
                    "-show_entries",
                    "format=duration:stream=codec_name,width,height,coded_width,coded_height,avg_frame_rate,duration:stream_tags=rotate:stream_side_data=rotation:frame=width,height,crop_top,crop_bottom,crop_left,crop_right",
                    "-of",
                    "json",
                    str(input_root / "back.mp4"),
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            probe_payload: JsonValue = json.loads(probe_completed.stdout)
            metadata = parse_probe_payload(probe_payload)
            self.assertEqual(metadata.crop[2], 2)
            self.assertFalse(probe_is_supported(metadata))
            request_path = root / "request.json"
            request_path.write_text(
                '{"schemaVersion":1,"clipId":"crop","camera":"back","relativePath":"back.mp4"}'
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "sentry_analyzer.back_impact_cli",
                    "--request",
                    str(request_path),
                    "--input-root",
                    str(input_root),
                    "--output-root",
                    str(root / "output"),
                ],
                text=True,
                capture_output=True,
                check=False,
                timeout=30,
            )
            result: JsonValue = json.loads((root / "output/result.json").read_text())
            self.assertEqual(completed.returncode, 3)
            self.assertIsInstance(result, dict)
            if isinstance(result, dict):
                self.assertEqual(
                    (result.get("status"), result.get("issues")),
                    ("indeterminate", ["unsupported_video"]),
                )


if __name__ == "__main__":
    unittest.main()
