from __future__ import annotations

import shutil
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sentry_analyzer.preprocess import (
    ContractError,
    EventClipInput,
    EventPreprocessRequest,
    FFmpegMediaTool,
    FrameMetadata,
    MediaToolError,
    ProbeMetadata,
    parse_request,
    preprocess_event,
)


class FakeMediaTool:
    def __init__(self, probes: dict[str, ProbeMetadata | Exception]) -> None:
        self.probes = probes
        self.extractions: list[tuple[Path, Path, int, int]] = []

    def probe(self, input_path: Path) -> ProbeMetadata:
        value = self.probes[input_path.name]
        if isinstance(value, Exception):
            raise value
        return value

    def extract_frame(
        self,
        input_path: Path,
        output_path: Path,
        offset_ms: int,
        max_width: int,
    ) -> FrameMetadata:
        self.extractions.append((input_path, output_path, offset_ms, max_width))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"synthetic-jpeg")
        return FrameMetadata(width=640, height=360)


def clip(
    clip_id: str,
    camera: str,
    captured_at: str,
    relative_path: str,
) -> EventClipInput:
    return EventClipInput(
        clip_id=clip_id,
        camera=camera,
        captured_at=captured_at,
        relative_path=relative_path,
    )


def probe(
    duration_ms: int = 4_000,
    width: int = 1448,
    height: int = 938,
) -> ProbeMetadata:
    return ProbeMetadata(
        audio_present=False,
        average_frame_rate="30/1",
        codec_name="h264",
        duration_ms=duration_ms,
        height=height,
        pixel_format="yuv420p",
        width=width,
    )


class RequestContractTests(unittest.TestCase):
    def test_parses_schema_v1_request(self) -> None:
        parsed = parse_request(
            {
                "schemaVersion": 1,
                "eventId": "event-001",
                "clips": [
                    {
                        "clipId": "front-001",
                        "camera": "front",
                        "capturedAt": "2030-01-01T12:00:00",
                        "relativePath": "clips/front.mp4",
                    }
                ],
            }
        )

        self.assertEqual(parsed.event_id, "event-001")
        self.assertEqual(parsed.clips[0].camera, "front")

    def test_rejects_traversal_absolute_paths_unsupported_cameras_and_duplicate_ids(self) -> None:
        invalid_clips = [
            {
                "clipId": "same",
                "camera": "front",
                "capturedAt": "2030-01-01T12:00:00",
                "relativePath": "../private.mp4",
            },
            {
                "clipId": "same",
                "camera": "roof",
                "capturedAt": "not-a-timestamp",
                "relativePath": "/absolute.mp4",
            },
        ]

        with self.assertRaises(ContractError):
            parse_request({"schemaVersion": 1, "eventId": "event-001", "clips": invalid_clips})

    def test_rejects_more_than_256_clips(self) -> None:
        clips = [
            {
                "clipId": f"clip-{index}",
                "camera": "front",
                "capturedAt": "2030-01-01T12:00:00",
                "relativePath": f"clips/{index}.mp4",
            }
            for index in range(257)
        ]

        with self.assertRaisesRegex(ContractError, "256"):
            parse_request({"schemaVersion": 1, "eventId": "event-001", "clips": clips})

    def test_matches_upload_relative_path_limits(self) -> None:
        invalid_paths = [
            "a" * 257,
            "unsafe file.mp4",
            "clips/" + "b" * 129,
            "clips/bad\x00name.mp4",
            "clips//front.mp4",
            "clips/",
            "clips/front.txt",
        ]
        for relative_path in invalid_paths:
            with self.subTest(relative_path=relative_path), self.assertRaises(ContractError):
                parse_request(
                    {
                        "schemaVersion": 1,
                        "eventId": "event-001",
                        "clips": [
                            {
                                "clipId": "front-001",
                                "camera": "front",
                                "capturedAt": "2030-01-01T12:00:00",
                                "relativePath": relative_path,
                            }
                        ],
                    }
                )


class PreprocessEventTests(unittest.TestCase):
    def test_aligns_clips_and_extracts_one_midpoint_frame_per_clip(self) -> None:
        request = EventPreprocessRequest(
            event_id="event-001",
            clips=(
                clip("front-001", "front", "2030-01-01T12:00:00", "clips/front.mp4"),
                clip("back-001", "back", "2030-01-01T12:00:02", "clips/back.mp4"),
            ),
        )
        media = FakeMediaTool({"front.mp4": probe(4_000), "back.mp4": probe(2_000)})

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_root = root / "input"
            output_root = root / "output"
            (input_root / "clips").mkdir(parents=True)
            (input_root / "clips/front.mp4").write_bytes(b"front")
            (input_root / "clips/back.mp4").write_bytes(b"back")

            result = preprocess_event(request, input_root, output_root, media)

            self.assertEqual(result.status, "ready")
            self.assertEqual(result.timeline.duration_ms, 4_000)
            self.assertEqual(
                [
                    (item.clip_id, item.timeline.start_ms, item.timeline.end_ms)
                    for item in result.clips
                ],
                [("front-001", 0, 4_000), ("back-001", 2_000, 4_000)],
            )
            self.assertEqual([item.frame.offset_ms for item in result.clips], [2_000, 1_000])
            self.assertEqual(
                [item.frame.relative_path for item in result.clips],
                [
                    "frames/000-front-front-001.jpg",
                    "frames/001-back-back-001.jpg",
                ],
            )
            self.assertEqual([item[2:] for item in media.extractions], [(2_000, 640), (1_000, 640)])
            self.assertTrue((output_root / "frames/000-front-front-001.jpg").is_file())
            self.assertEqual(result.issues, ())

    def test_preserves_unknown_camera_for_later_manual_review(self) -> None:
        request = EventPreprocessRequest(
            event_id="event-001",
            clips=(clip("unknown-001", "unknown", "2030-01-01T12:00:00", "unknown.mp4"),),
        )
        media = FakeMediaTool({"unknown.mp4": probe()})

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_root = root / "input"
            input_root.mkdir()
            (input_root / "unknown.mp4").write_bytes(b"unknown")

            result = preprocess_event(request, input_root, root / "output", media)

            self.assertEqual(result.status, "ready")
            self.assertEqual(result.clips[0].camera, "unknown")
            self.assertEqual(
                result.clips[0].frame.relative_path,
                "frames/000-unknown-unknown-001.jpg",
            )

    def test_reports_partial_without_silently_dropping_a_failed_clip(self) -> None:
        request = EventPreprocessRequest(
            event_id="event-001",
            clips=(
                clip("front-001", "front", "2030-01-01T12:00:00", "front.mp4"),
                clip("back-001", "back", "2030-01-01T12:00:00", "back.mp4"),
            ),
        )
        media = FakeMediaTool(
            {
                "front.mp4": probe(),
                "back.mp4": MediaToolError("probe_failed", "ffprobe rejected the clip"),
            }
        )

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_root = root / "input"
            input_root.mkdir()
            (input_root / "front.mp4").write_bytes(b"front")
            (input_root / "back.mp4").write_bytes(b"back")

            result = preprocess_event(request, input_root, root / "output", media)

            self.assertEqual(result.status, "partial")
            self.assertEqual([item.clip_id for item in result.clips], ["front-001"])
            self.assertEqual(
                [(issue.clip_id, issue.code) for issue in result.issues],
                [("back-001", "probe_failed")],
            )

    def test_reports_failed_when_no_clip_can_be_processed(self) -> None:
        request = EventPreprocessRequest(
            event_id="event-001",
            clips=(clip("front-001", "front", "2030-01-01T12:00:00", "front.mp4"),),
        )
        media = FakeMediaTool({"front.mp4": MediaToolError("probe_failed", "bad media")})

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_root = root / "input"
            input_root.mkdir()
            (input_root / "front.mp4").write_bytes(b"front")

            result = preprocess_event(request, input_root, root / "output", media)

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.clips, ())
            self.assertEqual(result.timeline.duration_ms, 0)

    def test_rejects_oversized_source_dimensions_before_frame_decode(self) -> None:
        request = EventPreprocessRequest(
            event_id="event-001",
            clips=(clip("front-001", "front", "2030-01-01T12:00:00", "front.mp4"),),
        )
        media = FakeMediaTool({"front.mp4": probe(width=16_384, height=16_384)})

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_root = root / "input"
            input_root.mkdir()
            (input_root / "front.mp4").write_bytes(b"front")

            result = preprocess_event(request, input_root, root / "output", media)

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.issues[0].code, "invalid_probe")
            self.assertEqual(media.extractions, [])

    def test_rejects_a_symlink_that_escapes_the_input_root_before_media_execution(self) -> None:
        request = EventPreprocessRequest(
            event_id="event-001",
            clips=(clip("front-001", "front", "2030-01-01T12:00:00", "escape.mp4"),),
        )
        media = FakeMediaTool({"outside.mp4": probe()})

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_root = root / "input"
            input_root.mkdir()
            outside = root / "outside.mp4"
            outside.write_bytes(b"outside")
            (input_root / "escape.mp4").symlink_to(outside)

            with self.assertRaisesRegex(ContractError, "input root"):
                preprocess_event(request, input_root, root / "output", media)

            self.assertEqual(media.extractions, [])
            self.assertFalse((root / "output").exists())

    def test_rejects_a_symlink_loop_before_media_execution(self) -> None:
        request = EventPreprocessRequest(
            event_id="event-001",
            clips=(clip("front-001", "front", "2030-01-01T12:00:00", "loop.mp4"),),
        )
        media = FakeMediaTool({})

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_root = root / "input"
            input_root.mkdir()
            (input_root / "loop.mp4").symlink_to("loop.mp4")

            with self.assertRaisesRegex(ContractError, "clip path"):
                preprocess_event(request, input_root, root / "output", media)

            self.assertEqual(media.extractions, [])
            self.assertFalse((root / "output").exists())

    def test_rejects_a_nonempty_output_root_without_deleting_existing_files(self) -> None:
        request = EventPreprocessRequest(
            event_id="event-001",
            clips=(clip("front-001", "front", "2030-01-01T12:00:00", "front.mp4"),),
        )
        media = FakeMediaTool({"front.mp4": probe()})

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_root = root / "input"
            input_root.mkdir()
            (input_root / "front.mp4").write_bytes(b"front")
            output_root = root / "output"
            output_root.mkdir()
            sentinel = output_root / "existing.txt"
            sentinel.write_text("keep", encoding="utf-8")

            with self.assertRaisesRegex(ContractError, "output root"):
                preprocess_event(request, input_root, output_root, media)

            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
            self.assertEqual(media.extractions, [])

    def test_rejects_an_output_root_symlink_before_media_execution(self) -> None:
        request = EventPreprocessRequest(
            event_id="event-001",
            clips=(clip("front-001", "front", "2030-01-01T12:00:00", "front.mp4"),),
        )
        media = FakeMediaTool({"front.mp4": probe()})

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_root = root / "input"
            input_root.mkdir()
            (input_root / "front.mp4").write_bytes(b"front")
            real_output = root / "real-output"
            real_output.mkdir()
            output_link = root / "output"
            output_link.symlink_to(real_output, target_is_directory=True)

            with self.assertRaisesRegex(ContractError, "output root"):
                preprocess_event(request, input_root, output_link, media)

            self.assertEqual(media.extractions, [])
            self.assertEqual(list(real_output.iterdir()), [])


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
class FFmpegIntegrationTests(unittest.TestCase):
    def test_does_not_inherit_ffreport_environment(self) -> None:
        fixture = (
            Path(__file__).resolve().parents[3]
            / "packages/video-preflight/tests/fixtures/one-second-avc.mp4"
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            report_path = Path(temporary_directory) / "ffreport.log"
            with patch.dict(
                "os.environ",
                {"FFREPORT": f"file={report_path}:level=32"},
                clear=False,
            ):
                metadata = FFmpegMediaTool().probe(fixture)

            self.assertEqual(metadata.codec_name, "h264")
            self.assertFalse(report_path.exists())

    def test_probes_fixture_and_generates_a_real_representative_jpeg(self) -> None:
        repository_root = Path(__file__).resolve().parents[3]
        fixture = repository_root / "packages/video-preflight/tests/fixtures/one-second-avc.mp4"
        request = EventPreprocessRequest(
            event_id="fixture-event",
            clips=(clip("front-fixture", "front", "2030-01-01T12:00:00", "front.mp4"),),
        )

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_root = root / "input"
            input_root.mkdir()
            shutil.copyfile(fixture, input_root / "front.mp4")

            result = preprocess_event(request, input_root, root / "output", FFmpegMediaTool())

            self.assertEqual(result.status, "ready")
            self.assertEqual(result.clips[0].probe.codec_name, "h264")
            self.assertEqual((result.clips[0].probe.width, result.clips[0].probe.height), (160, 90))
            frame_path = root / "output" / result.clips[0].frame.relative_path
            self.assertTrue(frame_path.is_file())
            self.assertGreater(frame_path.stat().st_size, 100)
            self.assertEqual(stat.S_IMODE(frame_path.stat().st_mode), 0o600)
            self.assertEqual(frame_path.read_bytes()[:2], b"\xff\xd8")


if __name__ == "__main__":
    unittest.main()
