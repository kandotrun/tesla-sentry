from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import tracemalloc
import unittest
from pathlib import Path
from unittest.mock import patch

from sentry_analyzer.back_impact_io import open_input
from sentry_analyzer.back_impact_media import FFmpegBackImpactMedia
from sentry_analyzer.back_impact_probe import TRACE_LIMIT_BYTES, MediaIssue

SPS_TRACE = "\n".join(
    (
        "[trace_headers] 1 chroma_format_idc 1 = 1",
        "[trace_headers] 1 frame_cropping_flag 1 = 1",
        "[trace_headers] 1 frame_crop_left_offset 1 = 0",
        "[trace_headers] 1 frame_crop_right_offset 1 = 4",
        "[trace_headers] 1 frame_crop_top_offset 1 = 0",
        "[trace_headers] 1 frame_crop_bottom_offset 1 = 3",
    )
)
PROBE_PAYLOAD = (
    '{"streams":[{"codec_name":"h264","width":1448,"height":938,'
    '"coded_width":1456,"coded_height":944,"avg_frame_rate":"8/1","duration":"4"}],'
    '"frames":[{"width":1456,"height":944,"crop_top":0,"crop_bottom":6,'
    '"crop_left":0,"crop_right":8,"side_data_list":[{}]}],'
    '"format":{"duration":"4"},"programs":[],"stream_groups":[]}'
)
CAPTURE_MEMORY_OVERHEAD_BYTES = 256 * 1024


class CaptureMedia(FFmpegBackImpactMedia):
    def capture(self, process: subprocess.Popen[bytes]) -> tuple[int, bytes]:
        return self._capture_output(process)

    def stop(self, process: subprocess.Popen[bytes]) -> None:
        self._stop(process)


class BackImpactCaptureProcessTests(unittest.TestCase):
    def write_executable(self, path: Path, source: str) -> None:
        path.write_text(f"#!{sys.executable}\n{source}")
        path.chmod(0o700)

    def assert_process_gone(self, marker: Path) -> None:
        process_id = int(marker.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(process_id, 0)

    def create_input(self, root: Path) -> Path:
        input_root = root / "input"
        input_root.mkdir()
        (input_root / "back.mp4").write_bytes(b"synthetic")
        return input_root

    def test_trace_overflow_is_bounded_unsupported_and_reaped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = self.create_input(root)
            marker = root / "trace.pid"
            ffmpeg = root / "ffmpeg"
            self.write_executable(
                ffmpeg,
                "import os\n"
                f"marker = os.open({str(marker)!r}, os.O_WRONLY | os.O_CREAT, 0o600)\n"
                "os.write(marker, str(os.getpid()).encode())\n"
                "os.close(marker)\n"
                "chunk = b'x' * 65536\n"
                "while True:\n"
                " try:\n"
                "  os.write(2, chunk)\n"
                " except BrokenPipeError:\n"
                "  break\n",
            )
            media = FFmpegBackImpactMedia(ffmpeg_binary=str(ffmpeg), deadline_seconds=10)

            tracemalloc.start()
            try:
                with (
                    open_input(input_root, "back.mp4") as handle,
                    self.assertRaises(MediaIssue) as raised,
                ):
                    list(media.stream_frames(handle))
                _, peak_bytes = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()

            self.assertEqual(raised.exception.code, "unsupported_video")
            self.assertLessEqual(peak_bytes, TRACE_LIMIT_BYTES + CAPTURE_MEMORY_OVERHEAD_BYTES)
            self.assert_process_gone(marker)

    def test_probe_overflow_is_bounded_unsupported_and_reaped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = self.create_input(root)
            marker = root / "probe.pid"
            ffmpeg = root / "ffmpeg"
            ffprobe = root / "ffprobe"
            self.write_executable(ffmpeg, f"import os\nos.write(2, {SPS_TRACE.encode()!r})\n")
            self.write_executable(
                ffprobe,
                "import os\n"
                f"marker = os.open({str(marker)!r}, os.O_WRONLY | os.O_CREAT, 0o600)\n"
                "os.write(marker, str(os.getpid()).encode())\n"
                "os.close(marker)\n"
                "chunk = b'x' * 65536\n"
                "while True:\n"
                " try:\n"
                "  os.write(1, chunk)\n"
                " except BrokenPipeError:\n"
                "  break\n",
            )
            media = FFmpegBackImpactMedia(
                ffmpeg_binary=str(ffmpeg),
                ffprobe_binary=str(ffprobe),
                deadline_seconds=10,
            )

            tracemalloc.start()
            try:
                with (
                    open_input(input_root, "back.mp4") as handle,
                    self.assertRaises(MediaIssue) as raised,
                ):
                    list(media.stream_frames(handle))
                _, peak_bytes = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()

            self.assertEqual(raised.exception.code, "unsupported_video")
            self.assertLessEqual(peak_bytes, TRACE_LIMIT_BYTES + CAPTURE_MEMORY_OVERHEAD_BYTES)
            self.assert_process_gone(marker)

    def test_exact_limit_capture_has_no_full_payload_copy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            emitter = root / "emitter"
            self.write_executable(
                emitter,
                "import os\n"
                f"remaining = {TRACE_LIMIT_BYTES}\n"
                "chunk = b'x' * 65536\n"
                "while remaining:\n"
                " size = min(remaining, len(chunk))\n"
                " os.write(1, chunk[:size])\n"
                " remaining -= size\n",
            )
            process = subprocess.Popen(
                [str(emitter)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )

            tracemalloc.start()
            try:
                return_code, output = CaptureMedia(deadline_seconds=10).capture(process)
                _, peak_bytes = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()

            self.assertEqual((return_code, len(output)), (0, TRACE_LIMIT_BYTES))
            self.assertLessEqual(peak_bytes, TRACE_LIMIT_BYTES + CAPTURE_MEMORY_OVERHEAD_BYTES)

    def test_trace_capture_avoids_temporary_storage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = self.create_input(root)
            ffmpeg = root / "ffmpeg"
            ffprobe = root / "ffprobe"
            self.write_executable(ffmpeg, f"import os\nos.write(2, {SPS_TRACE.encode()!r})\n")
            self.write_executable(ffprobe, f"import os\nos.write(1, {PROBE_PAYLOAD.encode()!r})\n")
            media = FFmpegBackImpactMedia(
                ffmpeg_binary=str(ffmpeg),
                ffprobe_binary=str(ffprobe),
                deadline_seconds=10,
            )

            with (
                patch.object(tempfile, "TemporaryFile", side_effect=AssertionError),
                open_input(input_root, "back.mp4") as handle,
            ):
                frames = list(media.stream_frames(handle))

            self.assertEqual(frames, [])

    def test_capture_deadline_reaps_child(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sleeper = root / "sleeper"
            self.write_executable(sleeper, "import time\ntime.sleep(60)\n")
            process = subprocess.Popen(
                [str(sleeper)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )

            with self.assertRaises(MediaIssue) as raised:
                CaptureMedia(deadline_seconds=0.05).capture(process)

            self.assertEqual(raised.exception.code, "analysis_failed")
            self.assertIsNotNone(process.poll())

    def test_stop_kills_and_reaps_terminate_ignoring_child(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / "child"
            self.write_executable(
                child,
                "import os, signal, time\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "os.write(1, b'ready')\n"
                "time.sleep(60)\n",
            )
            process = subprocess.Popen(
                [str(child)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            stdout = process.stdout
            self.assertIsNotNone(stdout)
            assert stdout is not None
            self.assertEqual(stdout.read(5), b"ready")

            CaptureMedia(deadline_seconds=1).stop(process)
            stdout.close()

            self.assertIsNotNone(process.poll())


if __name__ == "__main__":
    unittest.main()
