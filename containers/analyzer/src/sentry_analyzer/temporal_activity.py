from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from statistics import pstdev
from typing import Literal, TypeAlias

TemporalIssue = (
    Literal["frame_timing_unreliable", "insufficient_frames", "low_visibility"]
    | Literal["unsupported_video"]
)


@dataclass(frozen=True, slots=True)
class GrayFrame:
    timestamp_ms: int
    pixels: bytes


@dataclass(frozen=True, slots=True)
class TemporalAnalysisConfig:
    frame_height: int
    frame_width: int
    maximum_interval_ms: int
    minimum_contrast: float
    minimum_frames: int
    minimum_interval_ms: int

    def __post_init__(self) -> None:
        dimensions = (self.frame_height, self.frame_width, self.minimum_frames)
        intervals = (self.minimum_interval_ms, self.maximum_interval_ms)
        if any(type(value) is not int or value <= 0 for value in (*dimensions, *intervals)):
            raise ValueError("invalid temporal analysis configuration")
        if self.minimum_interval_ms > self.maximum_interval_ms or self.minimum_contrast < 0:
            raise ValueError("invalid temporal analysis configuration")


@dataclass(frozen=True, slots=True)
class TemporalAnalysisSummary:
    analysis_start_ms: int
    analyzed_frames: int
    duration_ms: int
    issues: tuple[TemporalIssue, ...]


TransitionConsumer: TypeAlias = Callable[[int, bytes, bytes], None]


def analyze_temporal_frames(
    frames: Iterable[GrayFrame],
    config: TemporalAnalysisConfig,
    consume_transition: TransitionConsumer,
) -> TemporalAnalysisSummary:
    analyzed_frames = 0
    first_timestamp = 0
    last_timestamp = 0
    low_contrast_frames = 0
    previous_timestamp: int | None = None
    previous_pixels: bytes | None = None
    timing_reliable = True
    unsupported_video = False
    frame_bytes = config.frame_width * config.frame_height

    for frame in frames:
        analyzed_frames += 1
        if analyzed_frames == 1:
            first_timestamp = frame.timestamp_ms
        last_timestamp = frame.timestamp_ms
        if previous_timestamp is not None:
            interval = frame.timestamp_ms - previous_timestamp
            timing_reliable = timing_reliable and (
                config.minimum_interval_ms <= interval <= config.maximum_interval_ms
            )
        previous_timestamp = frame.timestamp_ms
        if len(frame.pixels) != frame_bytes:
            unsupported_video = True
            previous_pixels = None
            continue
        low_contrast_frames += pstdev(frame.pixels[::64]) < config.minimum_contrast
        if previous_pixels is not None:
            consume_transition(frame.timestamp_ms, previous_pixels, frame.pixels)
        previous_pixels = frame.pixels

    checks: tuple[tuple[bool, TemporalIssue], ...] = (
        (unsupported_video, "unsupported_video"),
        (analyzed_frames < config.minimum_frames, "insufficient_frames"),
        (not timing_reliable, "frame_timing_unreliable"),
        (analyzed_frames > 0 and low_contrast_frames * 2 >= analyzed_frames, "low_visibility"),
    )
    return TemporalAnalysisSummary(
        first_timestamp,
        analyzed_frames,
        max(0, last_timestamp - first_timestamp),
        tuple(issue for failed, issue in checks if failed),
    )
