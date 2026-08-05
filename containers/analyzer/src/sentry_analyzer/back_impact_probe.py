from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from fractions import Fraction
from typing import Final, Literal, TypeAlias

JsonValue: TypeAlias = bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"] | None
MediaIssueCode: TypeAlias = Literal["analysis_failed", "decode_failed", "unsupported_video"]
ROOT_REQUIRED_KEYS: Final = frozenset({"streams", "frames", "format", "programs"})
ROOT_KEYS: Final = ROOT_REQUIRED_KEYS | {"stream_groups"}
STREAM_KEYS: Final = frozenset(
    {
        "codec_name",
        "width",
        "height",
        "coded_width",
        "coded_height",
        "avg_frame_rate",
        "duration",
        "tags",
        "side_data_list",
    }
)
STREAM_REQUIRED_KEYS: Final = frozenset(
    {"codec_name", "width", "height", "coded_width", "coded_height", "avg_frame_rate", "duration"}
)
FRAME_KEYS: Final = frozenset(
    {"width", "height", "crop_top", "crop_bottom", "crop_left", "crop_right", "side_data_list"}
)
FRAME_REQUIRED_KEYS: Final = frozenset({"width", "height"})
FRAME_CROP_KEYS: Final = frozenset({"crop_top", "crop_bottom", "crop_left", "crop_right"})
TRACE_FIELDS: Final = (
    "chroma_format_idc",
    "frame_cropping_flag",
    "frame_crop_left_offset",
    "frame_crop_right_offset",
    "frame_crop_top_offset",
    "frame_crop_bottom_offset",
)
TRACE_PATTERN: Final = re.compile(r"\s([a-z_]+)\s+[01]+\s+=\s+(-?\d+)$")
TRACE_LIMIT_BYTES: Final = 1024 * 1024


class MediaIssue(Exception):
    code: MediaIssueCode
    __slots__ = ("code",)

    def __init__(self, code: MediaIssueCode) -> None:
        super().__init__("media analysis is indeterminate")
        self.code = code

    def __str__(self) -> str:
        return "media analysis is indeterminate"


@dataclass(frozen=True, slots=True)
class ProbeMetadata:
    codec_name: str
    coded_height: int
    coded_width: int
    crop: tuple[int, int, int, int]
    duration_seconds: float
    frame_rate: Fraction
    height: int
    rotation: int
    width: int


def probe_is_supported(probe: ProbeMetadata) -> bool:
    return (
        probe.codec_name == "h264"
        and probe.coded_width == 1456
        and probe.coded_height == 944
        and probe.width == 1448
        and probe.height == 938
        and 3.0 <= probe.duration_seconds <= 90.0
        and Fraction(1) <= probe.frame_rate <= Fraction(120)
        and probe.rotation == 0
        and probe.crop == (0, 6, 0, 8)
    )


def mapping(value: JsonValue) -> Mapping[str, JsonValue]:
    if not isinstance(value, dict):
        raise MediaIssue("unsupported_video")
    return value


def integer(value: JsonValue) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise MediaIssue("unsupported_video")
    return value


def _required_trace_field(line: str) -> str | None:
    candidates = tuple(name for name in TRACE_FIELDS if name in line)
    if len(candidates) > 1:
        raise MediaIssue("unsupported_video")
    return next(iter(candidates), None)


def parse_sps_trace(raw: bytes) -> tuple[int, int, int, int]:
    if not raw or len(raw) > TRACE_LIMIT_BYTES:
        raise MediaIssue("unsupported_video")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise MediaIssue("unsupported_video") from error
    occurrences: dict[str, list[int]] = {}
    for line in text.splitlines():
        candidate = _required_trace_field(line)
        if candidate is None:
            continue
        match = TRACE_PATTERN.search(line)
        if match is None or match.group(1) != candidate:
            raise MediaIssue("unsupported_video")
        name, raw_value = match.groups()
        occurrences.setdefault(name, []).append(int(raw_value))
    if frozenset(occurrences) != frozenset(TRACE_FIELDS):
        raise MediaIssue("unsupported_video")
    if len({len(values) for values in occurrences.values()}) != 1 or any(
        len(frozenset(values)) != 1 for values in occurrences.values()
    ):
        raise MediaIssue("unsupported_video")
    found = {name: next(iter(values)) for name, values in occurrences.items()}
    if found["chroma_format_idc"] != 1 or found["frame_cropping_flag"] != 1:
        raise MediaIssue("unsupported_video")
    offsets = (
        found["frame_crop_top_offset"],
        found["frame_crop_bottom_offset"],
        found["frame_crop_left_offset"],
        found["frame_crop_right_offset"],
    )
    if any(value < 0 for value in offsets):
        raise MediaIssue("unsupported_video")
    return (offsets[0] * 2, offsets[1] * 2, offsets[2] * 2, offsets[3] * 2)


def _number(value: JsonValue) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise MediaIssue("unsupported_video")
    try:
        result = float(value)
    except ValueError as error:
        raise MediaIssue("unsupported_video") from error
    if not math.isfinite(result):
        raise MediaIssue("unsupported_video")
    return result


def _rotation(stream: Mapping[str, JsonValue]) -> int:
    rotation = 0
    tags_value = stream.get("tags")
    if tags_value is not None:
        tags = mapping(tags_value)
        if not frozenset(tags) <= frozenset({"rotate"}):
            raise MediaIssue("unsupported_video")
        if "rotate" in tags:
            rotation = round(_number(tags["rotate"]))
    side_data = stream.get("side_data_list")
    if side_data is not None:
        if not isinstance(side_data, list):
            raise MediaIssue("unsupported_video")
        for value in side_data:
            entry = mapping(value)
            if frozenset(entry) != frozenset({"rotation"}):
                raise MediaIssue("unsupported_video")
            rotation = round(_number(entry["rotation"]))
    return rotation % 360


def parse_probe_payload(
    payload: JsonValue,
    sps_crop: tuple[int, int, int, int] | None = None,
) -> ProbeMetadata:
    try:
        root = mapping(payload)
        if not ROOT_REQUIRED_KEYS <= frozenset(root) <= ROOT_KEYS:
            raise MediaIssue("unsupported_video")
        if root["programs"] != [] or root.get("stream_groups", []) != []:
            raise MediaIssue("unsupported_video")
        streams = root["streams"]
        frames = root["frames"]
        if not isinstance(streams, list) or len(streams) != 1:
            raise MediaIssue("unsupported_video")
        if not isinstance(frames, list) or len(frames) > 1:
            raise MediaIssue("unsupported_video")
        stream = mapping(streams[0])
        if not STREAM_REQUIRED_KEYS <= frozenset(stream) <= STREAM_KEYS:
            raise MediaIssue("unsupported_video")
        codec_name = stream["codec_name"]
        rate_value = stream["avg_frame_rate"]
        if not isinstance(codec_name, str) or not isinstance(rate_value, str):
            raise MediaIssue("unsupported_video")
        width = integer(stream["width"])
        height = integer(stream["height"])
        coded_width = integer(stream["coded_width"])
        coded_height = integer(stream["coded_height"])
        frame_crop = None
        if frames:
            frame = mapping(frames[0])
            if not FRAME_REQUIRED_KEYS <= frozenset(frame) <= FRAME_KEYS:
                raise MediaIssue("unsupported_video")
            side_data = frame.get("side_data_list", [])
            if not isinstance(side_data, list) or any(mapping(item) for item in side_data):
                raise MediaIssue("unsupported_video")
            if (integer(frame["width"]), integer(frame["height"])) != (
                coded_width,
                coded_height,
            ):
                raise MediaIssue("unsupported_video")
            present_crop_keys = frozenset(frame) & FRAME_CROP_KEYS
            if present_crop_keys and present_crop_keys != FRAME_CROP_KEYS:
                raise MediaIssue("unsupported_video")
            if present_crop_keys:
                frame_crop = (
                    integer(frame["crop_top"]),
                    integer(frame["crop_bottom"]),
                    integer(frame["crop_left"]),
                    integer(frame["crop_right"]),
                )
        if sps_crop is None and frame_crop is None:
            raise MediaIssue("unsupported_video")
        if sps_crop is not None and frame_crop is not None and sps_crop != frame_crop:
            raise MediaIssue("unsupported_video")
        crop = sps_crop if sps_crop is not None else frame_crop
        if crop is None:
            raise MediaIssue("unsupported_video")
        if (coded_width - crop[2] - crop[3], coded_height - crop[0] - crop[1]) != (
            width,
            height,
        ):
            raise MediaIssue("unsupported_video")
        format_value = mapping(root["format"])
        if frozenset(format_value) != frozenset({"duration"}):
            raise MediaIssue("unsupported_video")
        duration_value = stream["duration"]
        duration = _number(
            duration_value if duration_value is not None else format_value["duration"]
        )
        return ProbeMetadata(
            codec_name,
            coded_height,
            coded_width,
            crop,
            duration,
            Fraction(rate_value),
            height,
            _rotation(stream),
            width,
        )
    except (KeyError, ValueError, ZeroDivisionError) as error:
        raise MediaIssue("unsupported_video") from error
