"""Fail-closed FFmpeg preprocessing for one TeslaCam event."""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from fractions import Fraction
from pathlib import Path, PurePosixPath
from typing import Literal, Protocol, cast

SCHEMA_VERSION = 1
PIPELINE_VERSION = "ffmpeg-event-preprocess-v1"
MAX_EVENT_CLIPS = 256
MAX_FRAME_WIDTH = 640
MAX_CLIP_DURATION_MS = 4 * 60 * 60 * 1_000
MAX_SOURCE_DIMENSION = 8_192
MAX_RELATIVE_PATH_CHARS = 256
MAX_PATH_SEGMENT_CHARS = 128

KnownCamera = Literal[
    "back",
    "front",
    "left_pillar",
    "left_repeater",
    "right_pillar",
    "right_repeater",
    "unknown",
]
PreprocessStatus = Literal["ready", "partial", "failed"]

KNOWN_CAMERAS: frozenset[str] = frozenset(
    {
        "back",
        "front",
        "left_pillar",
        "left_repeater",
        "right_pillar",
        "right_repeater",
        "unknown",
    }
)
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_PATH_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")
CAPTURED_AT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")


class ContractError(ValueError):
    """The request violates the event preprocessing contract."""


class MediaToolError(RuntimeError):
    """A safe, path-free media processing failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message


@dataclass(frozen=True, slots=True)
class EventClipInput:
    clip_id: str
    camera: str
    captured_at: str
    relative_path: str


@dataclass(frozen=True, slots=True)
class EventPreprocessRequest:
    event_id: str
    clips: tuple[EventClipInput, ...]
    schema_version: int = SCHEMA_VERSION


@dataclass(frozen=True, slots=True)
class ProbeMetadata:
    audio_present: bool
    average_frame_rate: str
    codec_name: str
    duration_ms: int
    height: int
    pixel_format: str | None
    width: int

    def to_dict(self) -> dict[str, object]:
        return {
            "audioPresent": self.audio_present,
            "averageFrameRate": self.average_frame_rate,
            "codecName": self.codec_name,
            "durationMs": self.duration_ms,
            "height": self.height,
            "pixelFormat": self.pixel_format,
            "width": self.width,
        }


@dataclass(frozen=True, slots=True)
class FrameMetadata:
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class ClipTimeline:
    start_ms: int
    end_ms: int

    def to_dict(self) -> dict[str, int]:
        return {"startMs": self.start_ms, "endMs": self.end_ms}


@dataclass(frozen=True, slots=True)
class EventTimeline:
    duration_ms: int

    def to_dict(self) -> dict[str, int]:
        return {"durationMs": self.duration_ms}


@dataclass(frozen=True, slots=True)
class RepresentativeFrame:
    offset_ms: int
    relative_path: str
    width: int
    height: int

    def to_dict(self) -> dict[str, object]:
        return {
            "offsetMs": self.offset_ms,
            "relativePath": self.relative_path,
            "width": self.width,
            "height": self.height,
        }


@dataclass(frozen=True, slots=True)
class ProcessedClip:
    clip_id: str
    camera: str
    captured_at: str
    timeline: ClipTimeline
    probe: ProbeMetadata
    frame: RepresentativeFrame

    def to_dict(self) -> dict[str, object]:
        return {
            "clipId": self.clip_id,
            "camera": self.camera,
            "capturedAt": self.captured_at,
            "timeline": self.timeline.to_dict(),
            "probe": self.probe.to_dict(),
            "frame": self.frame.to_dict(),
        }


@dataclass(frozen=True, slots=True)
class PreprocessIssue:
    clip_id: str
    code: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return {"clipId": self.clip_id, "code": self.code, "message": self.message}


@dataclass(frozen=True, slots=True)
class EventPreprocessResult:
    event_id: str
    status: PreprocessStatus
    timeline: EventTimeline
    clips: tuple[ProcessedClip, ...]
    issues: tuple[PreprocessIssue, ...]
    schema_version: int = SCHEMA_VERSION
    pipeline_version: str = PIPELINE_VERSION

    def to_dict(self) -> dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "pipelineVersion": self.pipeline_version,
            "eventId": self.event_id,
            "status": self.status,
            "timeline": self.timeline.to_dict(),
            "clips": [clip.to_dict() for clip in self.clips],
            "issues": [issue.to_dict() for issue in self.issues],
        }


class MediaTool(Protocol):
    def probe(self, input_path: Path) -> ProbeMetadata: ...

    def extract_frame(
        self,
        input_path: Path,
        output_path: Path,
        offset_ms: int,
        max_width: int,
    ) -> FrameMetadata: ...


def _parse_captured_at(value: str) -> datetime:
    if not CAPTURED_AT.fullmatch(value):
        raise ContractError("capturedAt must use YYYY-MM-DDTHH:MM:SS")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S")
    except ValueError as error:
        raise ContractError("capturedAt is not a valid timestamp") from error


def _validate_identifier(value: str, field_name: str) -> None:
    if not SAFE_IDENTIFIER.fullmatch(value):
        raise ContractError(f"{field_name} must be a safe identifier of at most 128 characters")


def _validate_relative_path(value: str) -> None:
    if not value or len(value) > MAX_RELATIVE_PATH_CHARS or "\\" in value:
        raise ContractError("relativePath must be a safe path of at most 256 characters")
    segments = value.split("/")
    if any(
        not segment
        or len(segment) > MAX_PATH_SEGMENT_CHARS
        or segment in {".", ".."}
        or not SAFE_PATH_SEGMENT.fullmatch(segment)
        for segment in segments
    ):
        raise ContractError("relativePath contains an unsafe path segment")
    if not value.lower().endswith(".mp4"):
        raise ContractError("relativePath must identify an MP4 file")


def _validate_request(request: EventPreprocessRequest) -> None:
    if request.schema_version != SCHEMA_VERSION:
        raise ContractError("schemaVersion must be 1")
    _validate_identifier(request.event_id, "eventId")
    if not request.clips:
        raise ContractError("clips must contain at least one item")
    if len(request.clips) > MAX_EVENT_CLIPS:
        raise ContractError(f"clips must contain at most {MAX_EVENT_CLIPS} items")

    clip_ids: set[str] = set()
    relative_paths: set[str] = set()
    for item in request.clips:
        _validate_identifier(item.clip_id, "clipId")
        if item.clip_id in clip_ids:
            raise ContractError("clipId values must be unique")
        clip_ids.add(item.clip_id)
        if item.camera not in KNOWN_CAMERAS:
            raise ContractError("camera is not supported by preprocessing v1")
        _parse_captured_at(item.captured_at)
        _validate_relative_path(item.relative_path)
        if item.relative_path in relative_paths:
            raise ContractError("relativePath values must be unique")
        relative_paths.add(item.relative_path)


def _required_mapping(value: object, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ContractError(f"{field_name} must be an object")
    return cast(Mapping[str, object], value)


def _required_string(mapping: Mapping[str, object], field_name: str) -> str:
    value = mapping.get(field_name)
    if not isinstance(value, str):
        raise ContractError(f"{field_name} must be a string")
    return value


def parse_request(payload: object) -> EventPreprocessRequest:
    root = _required_mapping(payload, "request")
    schema_version = root.get("schemaVersion")
    if isinstance(schema_version, bool) or schema_version != SCHEMA_VERSION:
        raise ContractError("schemaVersion must be 1")
    event_id = _required_string(root, "eventId")
    clips_payload = root.get("clips")
    if not isinstance(clips_payload, Sequence) or isinstance(
        clips_payload, (str, bytes, bytearray)
    ):
        raise ContractError("clips must be an array")
    clips_sequence = cast(Sequence[object], clips_payload)
    if len(clips_sequence) > MAX_EVENT_CLIPS:
        raise ContractError(f"clips must contain at most {MAX_EVENT_CLIPS} items")

    clips: list[EventClipInput] = []
    for index, raw_clip in enumerate(clips_sequence):
        item = _required_mapping(raw_clip, f"clips[{index}]")
        clips.append(
            EventClipInput(
                clip_id=_required_string(item, "clipId"),
                camera=_required_string(item, "camera"),
                captured_at=_required_string(item, "capturedAt"),
                relative_path=_required_string(item, "relativePath"),
            )
        )
    request = EventPreprocessRequest(
        event_id=event_id,
        clips=tuple(clips),
        schema_version=SCHEMA_VERSION,
    )
    _validate_request(request)
    return request


def _valid_probe(probe: ProbeMetadata) -> bool:
    if probe.codec_name not in {"h264", "hevc"}:
        return False
    if not (0 < probe.duration_ms <= MAX_CLIP_DURATION_MS):
        return False
    if not (0 < probe.width <= MAX_SOURCE_DIMENSION and 0 < probe.height <= MAX_SOURCE_DIMENSION):
        return False
    try:
        rate = Fraction(probe.average_frame_rate)
    except (ValueError, ZeroDivisionError):
        return False
    return 0 < rate <= 240


def _representative_offset_ms(probe: ProbeMetadata) -> int:
    frame_rate = Fraction(probe.average_frame_rate)
    frame_interval_ms = math.ceil(1_000 / frame_rate)
    return min(probe.duration_ms // 2, max(0, probe.duration_ms - frame_interval_ms))


def _resolve_inputs(
    request: EventPreprocessRequest,
    input_root: Path,
) -> tuple[Path, dict[str, Path | None]]:
    try:
        resolved_root = input_root.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ContractError("input root does not exist") from error
    if not resolved_root.is_dir():
        raise ContractError("input root must be a directory")

    resolved: dict[str, Path | None] = {}
    for item in request.clips:
        unresolved_candidate = resolved_root / PurePosixPath(item.relative_path)
        try:
            candidate = unresolved_candidate.resolve(strict=True)
        except FileNotFoundError:
            try:
                candidate = unresolved_candidate.resolve(strict=False)
            except (OSError, RuntimeError) as error:
                raise ContractError("clip path cannot be resolved") from error
        except (OSError, RuntimeError) as error:
            raise ContractError("clip path cannot be resolved") from error
        try:
            candidate.relative_to(resolved_root)
        except ValueError as error:
            raise ContractError("clip path escapes the input root") from error
        resolved[item.clip_id] = candidate if candidate.is_file() else None
    return resolved_root, resolved


def _validate_output_root(output_root: Path) -> None:
    if output_root.is_symlink():
        raise ContractError("output root must not be a symlink")
    if not output_root.exists():
        return
    if not output_root.is_dir():
        raise ContractError("output root must be a directory")
    try:
        if next(output_root.iterdir(), None) is not None:
            raise ContractError("output root must be empty")
    except OSError as error:
        raise ContractError("output root is unavailable") from error


def _issue(clip_id: str, code: str, message: str) -> PreprocessIssue:
    return PreprocessIssue(clip_id=clip_id, code=code, message=message)


def preprocess_event(
    request: EventPreprocessRequest,
    input_root: Path,
    output_root: Path,
    media_tool: MediaTool,
) -> EventPreprocessResult:
    _validate_request(request)
    _, input_paths = _resolve_inputs(request, input_root)
    _validate_output_root(output_root)
    captured_times = {item.clip_id: _parse_captured_at(item.captured_at) for item in request.clips}
    event_start = min(captured_times.values())

    processed: list[ProcessedClip] = []
    issues: list[PreprocessIssue] = []

    for index, item in enumerate(request.clips):
        input_path = input_paths[item.clip_id]
        if input_path is None:
            issues.append(_issue(item.clip_id, "input_missing", "The input clip is unavailable."))
            continue
        try:
            metadata = media_tool.probe(input_path)
        except MediaToolError as error:
            issues.append(_issue(item.clip_id, error.code, error.public_message))
            continue
        if not _valid_probe(metadata):
            issues.append(
                _issue(
                    item.clip_id, "invalid_probe", "The decoded media metadata is not supported."
                )
            )
            continue

        local_offset_ms = _representative_offset_ms(metadata)
        relative_frame_path = f"frames/{index:03d}-{item.camera}-{item.clip_id}.jpg"
        final_frame_path = output_root / PurePosixPath(relative_frame_path)
        temporary_frame_path = final_frame_path.with_suffix(".tmp.jpg")
        temporary_frame_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_frame_path.unlink(missing_ok=True)
        try:
            generated = media_tool.extract_frame(
                input_path,
                temporary_frame_path,
                local_offset_ms,
                MAX_FRAME_WIDTH,
            )
            if (
                not temporary_frame_path.is_file()
                or temporary_frame_path.stat().st_size <= 0
                or generated.width <= 0
                or generated.height <= 0
                or generated.width > MAX_FRAME_WIDTH
            ):
                raise MediaToolError(
                    "invalid_frame",
                    "The representative frame output is invalid.",
                )
            temporary_frame_path.chmod(0o600)
            temporary_frame_path.replace(final_frame_path)
        except MediaToolError as error:
            temporary_frame_path.unlink(missing_ok=True)
            issues.append(_issue(item.clip_id, error.code, error.public_message))
            continue

        start_ms = round((captured_times[item.clip_id] - event_start).total_seconds() * 1_000)
        processed.append(
            ProcessedClip(
                clip_id=item.clip_id,
                camera=item.camera,
                captured_at=item.captured_at,
                timeline=ClipTimeline(start_ms=start_ms, end_ms=start_ms + metadata.duration_ms),
                probe=metadata,
                frame=RepresentativeFrame(
                    offset_ms=local_offset_ms,
                    relative_path=relative_frame_path,
                    width=generated.width,
                    height=generated.height,
                ),
            )
        )

    if not processed:
        status: PreprocessStatus = "failed"
    elif issues:
        status = "partial"
    else:
        status = "ready"
    duration_ms = max((item.timeline.end_ms for item in processed), default=0)
    return EventPreprocessResult(
        event_id=request.event_id,
        status=status,
        timeline=EventTimeline(duration_ms=duration_ms),
        clips=tuple(processed),
        issues=tuple(issues),
    )


class FFmpegMediaTool:
    def __init__(
        self,
        ffmpeg_binary: str = "ffmpeg",
        ffprobe_binary: str = "ffprobe",
        timeout_seconds: float = 60.0,
    ) -> None:
        self.ffmpeg_binary = shutil.which(ffmpeg_binary) or ffmpeg_binary
        self.ffprobe_binary = shutil.which(ffprobe_binary) or ffprobe_binary
        self.timeout_seconds = timeout_seconds
        self.environment = {"LANG": "C", "LC_ALL": "C", "PATH": os.defpath}

    def _run(self, arguments: list[str], failure_code: str, failure_message: str) -> bytes:
        try:
            completed = subprocess.run(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=self.timeout_seconds,
                env=self.environment,
            )
        except FileNotFoundError as error:
            raise MediaToolError("tool_unavailable", "FFmpeg is not installed.") from error
        except subprocess.TimeoutExpired as error:
            raise MediaToolError("media_timeout", "Media processing timed out.") from error
        except OSError as error:
            raise MediaToolError(failure_code, failure_message) from error
        if completed.returncode != 0:
            raise MediaToolError(failure_code, failure_message)
        return completed.stdout

    @staticmethod
    def _positive_integer(value: object, field_name: str) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise MediaToolError("invalid_probe", f"FFprobe returned an invalid {field_name}.")
        return value

    def probe(self, input_path: Path) -> ProbeMetadata:
        output = self._run(
            [
                self.ffprobe_binary,
                "-v",
                "error",
                "-protocol_whitelist",
                "file",
                "-f",
                "mov",
                "-show_entries",
                "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt,duration",
                "-of",
                "json",
                str(input_path),
            ],
            "probe_failed",
            "FFprobe could not read the clip.",
        )
        try:
            payload = json.loads(output)
            streams = payload["streams"]
            video = next(stream for stream in streams if stream.get("codec_type") == "video")
            audio_present = any(stream.get("codec_type") == "audio" for stream in streams)
            duration_value = video.get("duration") or payload.get("format", {}).get("duration")
            duration_seconds = float(duration_value)
            if not math.isfinite(duration_seconds) or duration_seconds <= 0:
                raise ValueError("invalid duration")
            duration_ms = round(duration_seconds * 1_000)
            codec_name = video["codec_name"]
            average_frame_rate = video["avg_frame_rate"]
            pixel_format = video.get("pix_fmt")
            if not isinstance(codec_name, str) or not isinstance(average_frame_rate, str):
                raise TypeError("invalid stream metadata")
            if pixel_format is not None and not isinstance(pixel_format, str):
                raise TypeError("invalid pixel format")
            metadata = ProbeMetadata(
                audio_present=audio_present,
                average_frame_rate=average_frame_rate,
                codec_name=codec_name,
                duration_ms=duration_ms,
                height=self._positive_integer(video.get("height"), "height"),
                pixel_format=pixel_format,
                width=self._positive_integer(video.get("width"), "width"),
            )
        except (KeyError, TypeError, ValueError, StopIteration, json.JSONDecodeError) as error:
            raise MediaToolError(
                "invalid_probe", "FFprobe returned invalid media metadata."
            ) from error
        if not _valid_probe(metadata):
            raise MediaToolError("invalid_probe", "FFprobe returned unsupported media metadata.")
        return metadata

    def extract_frame(
        self,
        input_path: Path,
        output_path: Path,
        offset_ms: int,
        max_width: int,
    ) -> FrameMetadata:
        self._run(
            [
                self.ffmpeg_binary,
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-protocol_whitelist",
                "file",
                "-f",
                "mov",
                "-ss",
                f"{offset_ms / 1_000:.3f}",
                "-i",
                str(input_path),
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-vf",
                f"scale='min({max_width},iw)':-2,format=yuvj420p",
                "-q:v",
                "3",
                "-y",
                str(output_path),
            ],
            "frame_extraction_failed",
            "FFmpeg could not extract a representative frame.",
        )
        output = self._run(
            [
                self.ffprobe_binary,
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "json",
                str(output_path),
            ],
            "invalid_frame",
            "FFprobe could not inspect the representative frame.",
        )
        try:
            payload = json.loads(output)
            stream = payload["streams"][0]
            return FrameMetadata(
                width=self._positive_integer(stream.get("width"), "frame width"),
                height=self._positive_integer(stream.get("height"), "frame height"),
            )
        except (IndexError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise MediaToolError(
                "invalid_frame", "The representative frame metadata is invalid."
            ) from error
