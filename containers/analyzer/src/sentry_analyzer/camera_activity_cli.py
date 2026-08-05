from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Final, TypeAlias, TypedDict, assert_never

from .back_impact_io import InputHandle, open_input, open_output
from .back_impact_probe import JsonValue, MediaIssue
from .camera_activity import (
    CAMERA_ACTIVITY_ORDER,
    CameraActivityEventResult,
    CameraActivityIssue,
    CameraActivityResult,
    CameraActivityResultError,
    KnownCamera,
    aggregate_camera_activity,
    analyze_camera_frames,
)
from .camera_activity_media import (
    CameraActivityMedia,
    FFmpegCameraActivityMedia,
    MediaProcessError,
)

MAX_REQUEST_BYTES: Final = 1024 * 1024
SAFE_IDENTIFIER: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_SEGMENT: Final = re.compile(r"^[A-Za-z0-9._-]+$")
REQUEST_KEYS: Final = frozenset({"schemaVersion", "eventId", "cameras"})
CAMERA_KEYS: Final = frozenset({"camera", "clipId", "relativePath"})
EXIT_BY_STATUS: Final = {
    "activity_detected": 0,
    "no_activity_signal_observed": 0,
    "indeterminate": 3,
}
MediaFactory: TypeAlias = Callable[[KnownCamera], CameraActivityMedia]


class ResultSummary(TypedDict):
    status: str
    cameras: int
    activity: int
    indeterminate: int


class ContractError(ValueError):
    def __init__(self, field: str) -> None:
        super().__init__("invalid camera activity request")
        self.field = field

    def __str__(self) -> str:
        return "invalid camera activity request"


@dataclass(frozen=True, slots=True)
class CameraActivityInput:
    camera: KnownCamera
    clip_id: str
    relative_path: str


@dataclass(frozen=True, slots=True)
class CameraActivityRequest:
    event_id: str
    cameras: tuple[CameraActivityInput, ...]


def _mapping(value: JsonValue) -> Mapping[str, JsonValue]:
    if not isinstance(value, dict):
        raise ContractError("request")
    return value


def _relative_path(value: JsonValue) -> str:
    if not isinstance(value, str) or not value or len(value) > 256 or "\\" in value:
        raise ContractError("relativePath")
    segments = value.split("/")
    if any(
        not segment
        or len(segment) > 128
        or segment in {".", ".."}
        or SAFE_SEGMENT.fullmatch(segment) is None
        for segment in segments
    ):
        raise ContractError("relativePath")
    if not value.lower().endswith(".mp4"):
        raise ContractError("relativePath")
    return value


def parse_request(payload: JsonValue) -> CameraActivityRequest:
    root = _mapping(payload)
    if frozenset(root) != REQUEST_KEYS or root.get("schemaVersion") != 1:
        raise ContractError("schema")
    event_id = root.get("eventId")
    if not isinstance(event_id, str) or SAFE_IDENTIFIER.fullmatch(event_id) is None:
        raise ContractError("eventId")
    raw_cameras = root.get("cameras")
    if not isinstance(raw_cameras, list) or len(raw_cameras) != len(CAMERA_ACTIVITY_ORDER):
        raise ContractError("cameras")
    cameras: list[CameraActivityInput] = []
    for index, raw_camera in enumerate(raw_cameras):
        item = _mapping(raw_camera)
        if frozenset(item) != CAMERA_KEYS or item.get("camera") != CAMERA_ACTIVITY_ORDER[index]:
            raise ContractError("camera")
        camera = CAMERA_ACTIVITY_ORDER[index]
        clip_id = item.get("clipId")
        if not isinstance(clip_id, str) or SAFE_IDENTIFIER.fullmatch(clip_id) is None:
            raise ContractError("clipId")
        cameras.append(
            CameraActivityInput(camera, clip_id, _relative_path(item.get("relativePath")))
        )
    if len({item.clip_id for item in cameras}) != len(cameras):
        raise ContractError("clipId")
    if len({item.relative_path for item in cameras}) != len(cameras):
        raise ContractError("relativePath")
    return CameraActivityRequest(event_id, tuple(cameras))


def _analyze(
    item: CameraActivityInput,
    input_handle: InputHandle,
    media: CameraActivityMedia,
) -> CameraActivityResult:
    try:
        return analyze_camera_frames(item.camera, item.clip_id, media.stream_frames(input_handle))
    except MediaIssue as error:
        issue: CameraActivityIssue
        match error.code:
            case "unsupported_video":
                issue = "unsupported_video"
            case "decode_failed":
                issue = "decode_failed"
            case "analysis_failed":
                issue = "analysis_failed"
            case _:
                assert_never(error.code)
        return CameraActivityResult(
            0, 0, item.camera, None, item.clip_id, (issue,), None, "indeterminate"
        )


def _verify_inputs(handles: tuple[InputHandle, ...]) -> None:
    for handle in handles:
        handle.verify_unchanged()


def execute_request(
    request: CameraActivityRequest,
    input_root: Path,
    output_root: Path,
    media_factory: MediaFactory,
) -> CameraActivityEventResult:
    with ExitStack() as stack:
        try:
            handles = tuple(
                stack.enter_context(open_input(input_root, item.relative_path))
                for item in request.cameras
            )
            if len({handle.identity.object_key() for handle in handles}) != len(handles):
                raise ContractError("cameras")
            output_handle = stack.enter_context(open_output(output_root))
        except OSError as error:
            raise ContractError("path") from error
        results = tuple(
            _analyze(item, handle, media_factory(item.camera))
            for item, handle in zip(request.cameras, handles, strict=True)
        )
        _verify_inputs(handles)
        output_handle.verify_attached()
        result = aggregate_camera_activity(request.event_id, results)
        serialized = json.dumps(result.to_dict(), ensure_ascii=False, separators=(",", ":"))
        output_handle.write((serialized + "\n").encode(), lambda: _verify_inputs(handles))
        return result


def _read_request(path: Path) -> JsonValue:
    try:
        with path.open("rb") as request_file:
            raw = request_file.read(MAX_REQUEST_BYTES + 1)
    except OSError as error:
        raise ContractError("request") from error
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        raise ContractError("request")
    try:
        payload: JsonValue = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError("request") from error
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze one six-camera TeslaCam event.")
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        request = parse_request(_read_request(arguments.request))
        result = execute_request(
            request,
            arguments.input_root,
            arguments.output_root,
            FFmpegCameraActivityMedia,
        )
    except ContractError:
        message = '{"error":{"code":"invalid_request","message":"The request is invalid."}}'
        print(message, file=sys.stderr)
        return 2
    except (MediaProcessError, OSError, CameraActivityResultError, ArithmeticError):
        print('{"error":{"code":"processing_error","message":"Analysis failed."}}', file=sys.stderr)
        return 5
    summary: ResultSummary = {
        "status": result.status,
        "cameras": len(result.cameras),
        "activity": sum(item.status == "activity_detected" for item in result.cameras),
        "indeterminate": sum(item.status == "indeterminate" for item in result.cameras),
    }
    print(json.dumps(summary, separators=(",", ":")))
    return EXIT_BY_STATUS[result.status]


if __name__ == "__main__":
    raise SystemExit(main())
