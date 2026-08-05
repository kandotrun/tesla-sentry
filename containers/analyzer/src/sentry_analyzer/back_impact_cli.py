from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Mapping, Sequence
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Final, TypeAlias, TypedDict, assert_never

from .back_impact import (
    BackImpactIssue,
    BackImpactResult,
    BackImpactResultError,
    analyze_back_frames,
)
from .back_impact_io import InputHandle, open_input, open_output
from .back_impact_media import BackImpactMedia, FFmpegBackImpactMedia, MediaProcessError
from .back_impact_probe import MediaIssue

JsonValue: TypeAlias = bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"] | None
MAX_REQUEST_BYTES: Final = 1024 * 1024
SAFE_IDENTIFIER: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_SEGMENT: Final = re.compile(r"^[A-Za-z0-9._-]+$")
REQUEST_KEYS: Final = frozenset({"schemaVersion", "clipId", "camera", "relativePath"})
EXIT_BY_STATUS: Final = {
    "possible_contact": 0,
    "no_impact_signal_observed": 0,
    "indeterminate": 3,
}


class ResultSummary(TypedDict):
    status: str
    analyzedFrames: int
    issues: int


class ContractError(ValueError):
    field: str
    __slots__ = ("field",)

    def __init__(self, field: str) -> None:
        super().__init__("invalid back impact request")
        self.field = field

    def __str__(self) -> str:
        return "invalid back impact request"


@dataclass(frozen=True, slots=True)
class BackImpactRequest:
    clip_id: str
    relative_path: str


def _mapping(value: JsonValue) -> Mapping[str, JsonValue]:
    if not isinstance(value, dict):
        raise ContractError("request")
    return value


def parse_request(payload: JsonValue) -> BackImpactRequest:
    root = _mapping(payload)
    if frozenset(root) != REQUEST_KEYS or root.get("schemaVersion") != 1:
        raise ContractError("schema")
    clip_id = root.get("clipId")
    if not isinstance(clip_id, str) or SAFE_IDENTIFIER.fullmatch(clip_id) is None:
        raise ContractError("clipId")
    if root.get("camera") != "back":
        raise ContractError("camera")
    relative_path = root.get("relativePath")
    if not isinstance(relative_path, str):
        raise ContractError("relativePath")
    if not relative_path or len(relative_path) > 256 or "\\" in relative_path:
        raise ContractError("relativePath")
    segments = relative_path.split("/")
    if any(
        not segment
        or len(segment) > 128
        or segment in {".", ".."}
        or SAFE_SEGMENT.fullmatch(segment) is None
        for segment in segments
    ):
        raise ContractError("relativePath")
    if not relative_path.lower().endswith(".mp4"):
        raise ContractError("relativePath")
    return BackImpactRequest(clip_id, relative_path)


def _analyze(
    request: BackImpactRequest,
    input_handle: InputHandle,
    media: BackImpactMedia,
) -> BackImpactResult:
    try:
        return analyze_back_frames(request.clip_id, media.stream_frames(input_handle))
    except MediaIssue as error:
        issue: BackImpactIssue
        match error.code:
            case "unsupported_video":
                issue = "unsupported_video"
            case "decode_failed":
                issue = "decode_failed"
            case "analysis_failed":
                issue = "analysis_failed"
            case _:
                assert_never(error.code)
        return BackImpactResult(0, 0, None, request.clip_id, (issue,), None, "indeterminate")


def execute_request(
    request: BackImpactRequest,
    input_root: Path,
    output_root: Path,
    media: BackImpactMedia,
) -> BackImpactResult:
    stack = ExitStack()
    try:
        input_handle = stack.enter_context(open_input(input_root, request.relative_path))
        output_handle = stack.enter_context(open_output(output_root))
    except OSError as error:
        stack.close()
        raise ContractError("path") from error
    with stack:
        result = _analyze(request, input_handle, media)
        input_handle.verify_unchanged()
        output_handle.verify_attached()
        serialized = json.dumps(result.to_dict(), ensure_ascii=False, separators=(",", ":"))
        output_handle.write((serialized + "\n").encode())
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


def _error(code: str, message: str) -> None:
    print(json.dumps({"error": {"code": code, "message": message}}), file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze one TeslaCam back clip.")
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
            FFmpegBackImpactMedia(),
        )
    except ContractError:
        _error("invalid_request", "The back impact request is invalid.")
        return 2
    except (MediaProcessError, OSError, BackImpactResultError, ArithmeticError):
        _error("processing_error", "The back impact analysis could not be completed.")
        return 5
    summary: ResultSummary = {
        "status": result.status,
        "analyzedFrames": result.analyzed_frames,
        "issues": len(result.issues),
    }
    print(json.dumps(summary, separators=(",", ":")))
    return EXIT_BY_STATUS[result.status]


if __name__ == "__main__":
    raise SystemExit(main())
