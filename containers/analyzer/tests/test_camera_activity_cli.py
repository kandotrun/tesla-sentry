from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
from collections.abc import Iterable
from pathlib import Path
from unittest.mock import patch

from sentry_analyzer.back_impact_io import InputHandle, OutputHandle
from sentry_analyzer.back_impact_probe import JsonValue, MediaIssue
from sentry_analyzer.camera_activity import CAMERA_ACTIVITY_ORDER, KnownCamera
from sentry_analyzer.camera_activity_cli import (
    ContractError,
    execute_request,
    parse_request,
)
from sentry_analyzer.camera_activity_media import CameraActivityMedia
from sentry_analyzer.temporal_activity import GrayFrame

WIDTH = 160
HEIGHT = 104


def as_json(value: object) -> JsonValue:
    parsed: JsonValue = json.loads(json.dumps(value))
    return parsed


def clone_mapping(value: JsonValue) -> dict[str, JsonValue]:
    cloned = as_json(value)
    if not isinstance(cloned, dict):
        raise AssertionError("expected mapping")
    return cloned


def request_payload() -> JsonValue:
    return as_json(
        {
            "schemaVersion": 1,
            "eventId": "event-001",
            "cameras": [
                {
                    "camera": camera,
                    "clipId": f"{camera}-001",
                    "relativePath": f"event/{camera}.mp4",
                }
                for camera in CAMERA_ACTIVITY_ORDER
            ],
        }
    )


def frame(index: int, variant: int = 0) -> GrayFrame:
    return GrayFrame(
        index * 125,
        bytes(
            (x * (17 + variant * 13) + y * (31 + variant * 7) + variant * 97) % 256
            for y in range(HEIGHT)
            for x in range(WIDTH)
        ),
    )


class FakeMedia(CameraActivityMedia):
    def __init__(
        self,
        camera: KnownCamera,
        failed: KnownCamera | None = None,
        emit_activity: bool = True,
    ) -> None:
        self.camera = camera
        self.failed = failed
        self.emit_activity = emit_activity

    def stream_frames(self, input_handle: InputHandle) -> Iterable[GrayFrame]:
        _ = input_handle
        if self.camera == self.failed:
            raise MediaIssue("decode_failed")
        frames = [frame(index) for index in range(32)]
        if self.camera == "back" and self.emit_activity:
            frames[12] = frame(12, 1)
            frames[13] = frame(13, 2)
        return frames


class CameraActivityCliTests(unittest.TestCase):
    def test_parse_request_requires_exact_canonical_six_camera_order(self) -> None:
        valid = request_payload()
        assert isinstance(valid, dict)
        self.assertEqual(
            tuple(item.camera for item in parse_request(valid).cameras), CAMERA_ACTIVITY_ORDER
        )
        cameras = valid["cameras"]
        assert isinstance(cameras, list)
        missing = clone_mapping(valid)
        missing["cameras"] = cameras[:-1]
        reordered = clone_mapping(valid)
        reordered["cameras"] = [cameras[1], cameras[0], *cameras[2:]]
        duplicate = clone_mapping(valid)
        duplicate["cameras"] = [*cameras[:-1], cameras[-2]]
        extra = clone_mapping(valid)
        extra["privatePath"] = "/private/source"
        unsafe = clone_mapping(valid)
        first = clone_mapping(cameras[0])
        first["relativePath"] = "../private.mp4"
        unsafe["cameras"] = [first, *cameras[1:]]
        duplicate_clip_id = clone_mapping(valid)
        duplicate_clip_id_cameras = duplicate_clip_id["cameras"]
        assert isinstance(duplicate_clip_id_cameras, list)
        duplicate_clip_id_second = clone_mapping(duplicate_clip_id_cameras[1])
        duplicate_clip_id_second["clipId"] = "front-001"
        duplicate_clip_id["cameras"] = [
            duplicate_clip_id_cameras[0],
            duplicate_clip_id_second,
            *duplicate_clip_id_cameras[2:],
        ]
        duplicate_path = clone_mapping(valid)
        duplicate_path_cameras = duplicate_path["cameras"]
        assert isinstance(duplicate_path_cameras, list)
        duplicate_path_second = clone_mapping(duplicate_path_cameras[1])
        duplicate_path_second["relativePath"] = "event/front.mp4"
        duplicate_path["cameras"] = [
            duplicate_path_cameras[0],
            duplicate_path_second,
            *duplicate_path_cameras[2:],
        ]
        invalid: tuple[JsonValue, ...] = (
            missing,
            reordered,
            duplicate,
            extra,
            unsafe,
            duplicate_clip_id,
            duplicate_path,
        )
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ContractError):
                parse_request(payload)

    def test_execute_writes_exact_aggregate_with_private_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = root / "input"
            for camera in CAMERA_ACTIVITY_ORDER:
                path = input_root / "event" / f"{camera}.mp4"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"media")
            output_root = root / "output"
            request = parse_request(request_payload())

            result = execute_request(
                request,
                input_root,
                output_root,
                lambda camera: FakeMedia(camera),
            )

            self.assertEqual(result.status, "activity_detected")
            self.assertEqual(result.cameras[1].status, "activity_detected")
            stored = json.loads((output_root / "result.json").read_text())
            self.assertEqual(stored, result.to_dict())
            self.assertEqual(stat.S_IMODE((output_root / "result.json").stat().st_mode), 0o600)

    def test_execute_rejects_distinct_paths_to_the_same_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = root / "input"
            for camera in CAMERA_ACTIVITY_ORDER:
                path = input_root / "event" / f"{camera}.mp4"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"media")
            alias = input_root / "event/left_repeater.mp4"
            alias.unlink()
            os.link(input_root / "event/back.mp4", alias)
            output_root = root / "output"

            with self.assertRaises(ContractError):
                execute_request(
                    parse_request(request_payload()),
                    input_root,
                    output_root,
                    lambda camera: FakeMedia(camera),
                )

            self.assertFalse(output_root.exists())

    def test_input_mutation_during_result_publication_rolls_back_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = root / "input"
            for camera in CAMERA_ACTIVITY_ORDER:
                path = input_root / "event" / f"{camera}.mp4"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"media")
            output_root = root / "output"
            verify_attached = OutputHandle.verify_attached
            calls: list[None] = []

            def mutate_after_verification(handle: OutputHandle) -> None:
                verify_attached(handle)
                calls.append(None)
                if len(calls) == 3:
                    (input_root / "event/front.mp4").write_bytes(b"late-mutation")

            with (
                patch.object(OutputHandle, "verify_attached", mutate_after_verification),
                self.assertRaises(OSError),
            ):
                execute_request(
                    parse_request(request_payload()),
                    input_root,
                    output_root,
                    lambda camera: FakeMedia(camera),
                )

            self.assertFalse((output_root / "result.json").exists())

    def test_one_media_failure_makes_aggregate_indeterminate_without_activity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_root = root / "input"
            parsed = parse_request(request_payload())
            for item in parsed.cameras:
                path = input_root / item.relative_path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"media")

            result = execute_request(
                parsed,
                input_root,
                root / "output",
                lambda camera: FakeMedia(camera, "left_pillar", False),
            )

            self.assertEqual(result.status, "indeterminate")
            self.assertEqual(result.cameras[4].issues, ("decode_failed",))


if __name__ == "__main__":
    unittest.main()
