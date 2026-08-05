from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable, Iterable
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from sentry_analyzer.back_impact import FRAME_HEIGHT, FRAME_WIDTH, GrayFrame
from sentry_analyzer.back_impact_cli import (
    BackImpactRequest,
    ContractError,
    JsonValue,
    execute_request,
    main,
)
from sentry_analyzer.back_impact_io import FINAL_NAME, TEMPORARY_NAME, InputHandle, OutputHandle
from sentry_analyzer.back_impact_media import BackImpactMedia
from sentry_analyzer.back_impact_probe import MediaIssue


class FakeMedia(BackImpactMedia):
    def __init__(
        self,
        frames: Iterable[GrayFrame] | MediaIssue,
        action: Callable[[InputHandle], None] | None = None,
    ) -> None:
        self.frames = frames
        self.action = action
        self.calls = 0

    def stream_frames(self, input_handle: InputHandle) -> Iterable[GrayFrame]:
        self.calls += 1
        if self.action is not None:
            self.action(input_handle)
        if isinstance(self.frames, MediaIssue):
            raise self.frames
        return self.frames


def frame(index: int, shift: int = 0) -> GrayFrame:
    pixels = bytearray(FRAME_WIDTH * FRAME_HEIGHT)
    for y in range(FRAME_HEIGHT):
        for x in range(FRAME_WIDTH):
            pixels[y * FRAME_WIDTH + x] = (((x - shift) // 8 + y // 8) % 2) * 120 + 60
    return GrayFrame(index * 125, bytes(pixels))


def impact_frames() -> Iterable[GrayFrame]:
    shifts = [0] * 12 + [3, 3, 0] + [0] * 17
    return (frame(index, shift) for index, shift in enumerate(shifts))


def request(relative_path: str = "back.mp4") -> dict[str, JsonValue]:
    return dict(schemaVersion=1, clipId="back-001", camera="back", relativePath=relative_path)


class BackImpactCliTests(unittest.TestCase):
    def roots(self, root: Path) -> tuple[Path, Path]:
        input_root = root / "input"
        input_root.mkdir()
        (input_root / "back.mp4").write_bytes(b"media")
        return input_root, root / "output"

    def test_invalid_requests_exit_two_without_path_disclosure(self) -> None:
        invalid = (
            {**request(), "camera": "front"},
            request("/private/back.mp4"),
            request("clips/../private.mp4"),
            {**request(), "privatePath": "secret"},
            {**request(), "clipId": "-unsafe"},
        )
        for payload in invalid:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                request_path = root / "request.json"
                request_path.write_text(json.dumps(payload))
                stdout, stderr = StringIO(), StringIO()
                arguments = ["--request", str(request_path), "--input-root", str(root)]
                arguments += ["--output-root", str(root / "output")]
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    code = main(arguments)
                self.assertEqual((code, stdout.getvalue()), (2, ""))
                self.assertEqual(json.loads(stderr.getvalue())["error"]["code"], "invalid_request")
                self.assertNotIn(str(root), stderr.getvalue())

    def test_rejects_unsafe_paths_and_dangling_result_links(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root, output_root = self.roots(root)
            outside = root / "outside.mp4"
            outside.write_bytes(b"keep")
            (input_root / "escape.mp4").symlink_to(outside)
            for relative in ("escape.mp4", "missing.mp4"):
                media = FakeMedia(())
                with self.subTest(relative=relative), self.assertRaises(ContractError):
                    execute_request(
                        BackImpactRequest("back-001", relative), input_root, output_root, media
                    )
                self.assertEqual(media.calls, 0)
            for name in ("result.tmp.json", "result.json"):
                output_root.mkdir(exist_ok=True)
                (output_root / name).symlink_to(root / "dangling")
                parsed = BackImpactRequest("back-001", "back.mp4")
                with self.assertRaises(ContractError):
                    execute_request(parsed, input_root, output_root, FakeMedia(()))
                (output_root / name).unlink()
            self.assertEqual(outside.read_bytes(), b"keep")

    def test_leaf_input_swap_fails_closed_without_writing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root, output_root = self.roots(root)
            sentinel = root / "sentinel.mp4"
            sentinel.write_bytes(b"private")
            before = sentinel.stat()

            def swap(_: InputHandle) -> None:
                (input_root / "back.mp4").rename(input_root / "old.mp4")
                (input_root / "back.mp4").write_bytes(b"replacement")

            with self.assertRaises(OSError):
                execute_request(
                    BackImpactRequest("back-001", "back.mp4"),
                    input_root,
                    output_root,
                    FakeMedia(impact_frames(), swap),
                )
            after = sentinel.stat()
            self.assertEqual(
                (sentinel.read_bytes(), after.st_mtime_ns), (b"private", before.st_mtime_ns)
            )
            self.assertFalse((output_root / "result.json").exists())

    def test_in_place_input_mutation_fails_closed_without_writing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root, output_root = self.roots(root)

            def mutate(_: InputHandle) -> None:
                (input_root / "back.mp4").write_bytes(b"mutated-media")

            with self.assertRaises(OSError):
                execute_request(
                    BackImpactRequest("back-001", "back.mp4"),
                    input_root,
                    output_root,
                    FakeMedia(impact_frames(), mutate),
                )

            self.assertFalse((output_root / "result.json").exists())

    def test_output_swap_fails_closed_without_touching_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root, output_root = self.roots(root)
            sentinel_mtime: list[int] = []

            def swap(_: InputHandle) -> None:
                output_root.rename(root / "old-output")
                output_root.mkdir()
                (output_root / "sentinel").write_bytes(b"keep")
                sentinel_mtime.append((output_root / "sentinel").stat().st_mtime_ns)

            with self.assertRaises(OSError):
                execute_request(
                    BackImpactRequest("back-001", "back.mp4"),
                    input_root,
                    output_root,
                    FakeMedia(impact_frames(), swap),
                )
            self.assertEqual((output_root / "sentinel").read_bytes(), b"keep")
            self.assertEqual((output_root / "sentinel").stat().st_mtime_ns, sentinel_mtime[0])
            self.assertFalse((output_root / "result.json").exists())
            self.assertFalse((root / "old-output/result.json").exists())

    def test_output_swap_during_publication_rolls_back_detached_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root, output_root = self.roots(root)
            detached_output = root / "detached-output"
            link = os.link

            def swap_then_link(
                src: str,
                dst: str,
                *,
                src_dir_fd: int | None = None,
                dst_dir_fd: int | None = None,
                follow_symlinks: bool = True,
            ) -> None:
                output_root.rename(detached_output)
                output_root.mkdir()
                link(
                    src,
                    dst,
                    src_dir_fd=src_dir_fd,
                    dst_dir_fd=dst_dir_fd,
                    follow_symlinks=follow_symlinks,
                )

            with (
                patch("sentry_analyzer.back_impact_io.os.link", swap_then_link),
                self.assertRaises(OSError),
            ):
                execute_request(
                    BackImpactRequest("back-001", "back.mp4"),
                    input_root,
                    output_root,
                    FakeMedia(impact_frames()),
                )

            self.assertFalse((output_root / "result.json").exists())
            self.assertFalse((detached_output / "result.json").exists())

    def test_late_final_entry_is_not_replaced(self) -> None:
        def run(entry_type: str) -> None:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                input_root, output_root = self.roots(root)
                entry = output_root / FINAL_NAME
                calls: list[None] = []
                before: list[tuple[int, int, bytes | str]] = []
                verify_attached = OutputHandle.verify_attached

                def publish_barrier(handle: OutputHandle) -> None:
                    verify_attached(handle)
                    calls.append(None)
                    if len(calls) == 4:
                        if entry_type == "regular":
                            entry.write_bytes(b"late")
                        else:
                            entry.symlink_to(root / "missing")
                        metadata = entry.lstat()
                        value = (
                            entry.read_bytes() if entry_type == "regular" else os.readlink(entry)
                        )
                        before.append((metadata.st_ino, metadata.st_mtime_ns, value))

                with (
                    patch.object(OutputHandle, "verify_attached", publish_barrier),
                    self.assertRaises(FileExistsError),
                ):
                    execute_request(
                        BackImpactRequest("back-001", "back.mp4"),
                        input_root,
                        output_root,
                        FakeMedia(impact_frames()),
                    )
                metadata = entry.lstat()
                value = entry.read_bytes() if entry_type == "regular" else os.readlink(entry)
                self.assertEqual((metadata.st_ino, metadata.st_mtime_ns, value), before[0])
                self.assertFalse((output_root / TEMPORARY_NAME).exists())

        for entry_type in ("regular", "dangling"):
            with self.subTest(entry_type=entry_type):
                run(entry_type)

    def test_input_root_swap_keeps_open_descriptor_anchored(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root, output_root = self.roots(root)

            def swap(handle: InputHandle) -> None:
                input_root.rename(root / "old-input")
                input_root.mkdir()
                (input_root / "back.mp4").write_bytes(b"replacement")
                self.assertEqual(os.pread(handle.fileno(), 5, 0), b"media")

            result = execute_request(
                BackImpactRequest("back-001", "back.mp4"),
                input_root,
                output_root,
                FakeMedia(impact_frames(), swap),
            )
            self.assertEqual(result.status, "possible_contact")
            self.assertEqual(stat.S_IMODE((output_root / "result.json").stat().st_mode), 0o600)

    def test_maps_media_failures_to_indeterminate(self) -> None:
        for issue in ("unsupported_video", "decode_failed", "analysis_failed"):
            with self.subTest(issue=issue), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                input_root, output_root = self.roots(root)
                result = execute_request(
                    BackImpactRequest("back-001", "back.mp4"),
                    input_root,
                    output_root,
                    FakeMedia(MediaIssue(issue)),
                )
                self.assertEqual((result.status, result.issues), ("indeterminate", (issue,)))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
class BackImpactRealCliTests(unittest.TestCase):
    def test_real_static_and_impact_videos(self) -> None:
        for impact, expected in ((False, "no_impact_signal_observed"), (True, "possible_contact")):
            with self.subTest(impact=impact), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                frames = root / "frames"
                frames.mkdir()
                for index in range(32):
                    shift = 3 if impact and index in {12, 13} else 0
                    pixels = frame(index, shift).pixels
                    (frames / f"{index:03d}.pgm").write_bytes(b"P5\n160 104\n255\n" + pixels)
                input_root = root / "input"
                input_root.mkdir()
                encode = ["ffmpeg", "-loglevel", "error", "-framerate", "8"]
                encode += ["-i", str(frames / "%03d.pgm")]
                encode += ["-vf", "scale=1448:938:flags=neighbor,format=yuv420p"]
                encode += ["-c:v", "libx264", "-profile:v", "high", str(input_root / "back.mp4")]
                subprocess.run(encode, check=True)
                request_path = root / "request.json"
                request_path.write_text(json.dumps(request()))
                command = [sys.executable, "-m", "sentry_analyzer.back_impact_cli"]
                command += ["--request", str(request_path), "--input-root", str(input_root)]
                command += ["--output-root", str(root / "output")]
                completed = subprocess.run(
                    command, text=True, capture_output=True, check=False, timeout=30
                )
                result = json.loads((root / "output/result.json").read_text())
                self.assertEqual(
                    (completed.returncode, result["status"]), (0, expected), completed.stderr
                )


if __name__ == "__main__":
    unittest.main()
