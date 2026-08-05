from __future__ import annotations

import math
import re
from collections import deque
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from functools import partial
from statistics import median, pstdev
from typing import Final, Literal, TypedDict, assert_never

SCHEMA_VERSION: Final = 1
ANALYZER_VERSION: Final = "back-temporal-impact-v1"
FRAME_WIDTH: Final = 160
FRAME_HEIGHT: Final = 104
SAMPLE_RATE: Final = 8
MAX_SHIFT: Final = 3
MIN_FRAMES: Final = 24
GLOBAL_MOTION_THRESHOLD: Final = 0.45
IMPULSE_THRESHOLD: Final = 0.35
RECOVERY_THRESHOLD: Final = 0.35
MIN_CONTRAST: Final = 12.0
SAFE_CLIP_ID: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

BackImpactIssue = (
    Literal["analysis_failed", "decode_failed", "frame_timing_unreliable"]
    | Literal["insufficient_frames", "low_visibility", "unsupported_video"]
)
BackImpactStatus = Literal["possible_contact", "no_impact_signal_observed", "indeterminate"]
ALLOWED_ISSUES: Final[tuple[BackImpactIssue, ...]] = (
    *("analysis_failed", "decode_failed", "frame_timing_unreliable"),
    "insufficient_frames",
    "low_visibility",
    "unsupported_video",
)


class BackImpactMetricsPayload(TypedDict):
    globalMotionScore: float
    impulseScore: float
    recoveryScore: float


class BackImpactResultPayload(TypedDict):
    analysisDurationMs: int
    analyzedFrames: int
    analyzerVersion: Literal["back-temporal-impact-v1"]
    camera: Literal["back"]
    candidateTimestampMs: int | None
    clipId: str
    issues: list[BackImpactIssue]
    metrics: BackImpactMetricsPayload | None
    schemaVersion: Literal[1]
    source: Literal["back_temporal_motion"]
    status: BackImpactStatus


@dataclass(frozen=True, slots=True)
class BackImpactResultError(ValueError):
    field: str

    def __str__(self) -> str:
        return f"invalid back impact result field: {self.field}"


@dataclass(frozen=True, slots=True)
class GrayFrame:
    timestamp_ms: int
    pixels: bytes


@dataclass(frozen=True, slots=True)
class BackImpactMetrics:
    global_motion_score: float
    impulse_score: float
    recovery_score: float

    def is_normalized(self) -> bool:
        scores = (self.global_motion_score, self.impulse_score, self.recovery_score)
        return all(math.isfinite(score) and 0.0 <= score <= 1.0 for score in scores)


def _safe_integer(value: int) -> bool:
    return type(value) is int and 0 <= value <= 2**53 - 1


@dataclass(frozen=True, slots=True)
class BackImpactResult:
    analysis_duration_ms: int
    analyzed_frames: int
    candidate_timestamp_ms: int | None
    clip_id: str
    issues: tuple[BackImpactIssue, ...]
    metrics: BackImpactMetrics | None
    status: BackImpactStatus

    def __post_init__(self) -> None:
        if not all(map(_safe_integer, (self.analysis_duration_ms, self.analyzed_frames))):
            raise BackImpactResultError("integer")
        candidate = self.candidate_timestamp_ms
        if candidate is not None and (
            not _safe_integer(candidate) or candidate > self.analysis_duration_ms
        ):
            raise BackImpactResultError("candidate_timestamp_ms")
        metrics = self.metrics
        if metrics is not None and not metrics.is_normalized():
            raise BackImpactResultError("metrics")
        if SAFE_CLIP_ID.fullmatch(self.clip_id) is None:
            raise BackImpactResultError("clip_id")
        match (self.status,):
            case ("possible_contact",):
                valid = candidate is not None and metrics is not None and not self.issues
            case ("no_impact_signal_observed",):
                valid = candidate is None and metrics is not None and not self.issues
            case ("indeterminate",):
                valid = (
                    candidate is None
                    and metrics is None
                    and bool(self.issues)
                    and all(issue in ALLOWED_ISSUES for issue in self.issues)
                )
            case _:
                assert_never(self.status)
        if not valid:
            raise BackImpactResultError("status")

    def to_dict(self) -> BackImpactResultPayload:
        metrics = self.metrics
        metrics_payload: BackImpactMetricsPayload | None = None
        if metrics is not None:
            metrics_payload = {
                "globalMotionScore": round(metrics.global_motion_score, 6),
                "impulseScore": round(metrics.impulse_score, 6),
                "recoveryScore": round(metrics.recovery_score, 6),
            }
        return {
            "analysisDurationMs": self.analysis_duration_ms,
            "analyzedFrames": self.analyzed_frames,
            "analyzerVersion": ANALYZER_VERSION,
            "camera": "back",
            "candidateTimestampMs": self.candidate_timestamp_ms,
            "clipId": self.clip_id,
            "issues": list(self.issues),
            "metrics": metrics_payload,
            "schemaVersion": SCHEMA_VERSION,
            "source": "back_temporal_motion",
            "status": self.status,
        }


@dataclass(frozen=True, slots=True)
class _Shift:
    dx: int
    dy: int


@dataclass(frozen=True, slots=True)
class _MotionSample:
    timestamp_ms: int
    shift: _Shift
    score: float


def _gradient(pixels: bytes, index: int) -> tuple[int, int]:
    horizontal = pixels[index + 1] - pixels[index - 1]
    vertical = pixels[index + FRAME_WIDTH] - pixels[index - FRAME_WIDTH]
    return horizontal, vertical


def _gradient_errors(previous: bytes, current: bytes, shift: _Shift) -> tuple[int, ...]:
    errors = [0, 0, 0, 0, 0]
    for y in range(8, FRAME_HEIGHT - 8, 8):
        for x in range(8, FRAME_WIDTH - 8, 8):
            current_index = (y + shift.dy) * FRAME_WIDTH + x + shift.dx
            gradients = zip(
                _gradient(previous, y * FRAME_WIDTH + x),
                _gradient(current, current_index),
                strict=True,
            )
            difference = sum(
                abs(previous_value - current_value) for previous_value, current_value in gradients
            )
            region = 1 + int(x >= FRAME_WIDTH // 2) + 2 * int(y >= FRAME_HEIGHT // 2)
            errors[0] += difference
            errors[region] += difference
    return tuple(errors)


def _estimate_translation(previous: bytes, current: bytes) -> _MotionSample:
    zero_errors = _gradient_errors(previous, current, _Shift(0, 0))
    best_shift = _Shift(0, 0)
    best_errors = zero_errors
    for dy in range(-MAX_SHIFT, MAX_SHIFT + 1):
        for dx in range(-MAX_SHIFT, MAX_SHIFT + 1):
            shift = _Shift(dx, dy)
            errors = _gradient_errors(previous, current, shift)
            if errors[0] < best_errors[0]:
                best_shift = shift
                best_errors = errors
    improvement = 0.0
    if zero_errors[0] > 0.0:
        improvement = (zero_errors[0] - best_errors[0]) / zero_errors[0]
    agreement = sum(best_errors[index] < zero_errors[index] for index in range(1, 5)) / 4
    magnitude = math.hypot(best_shift.dx, best_shift.dy) / math.hypot(MAX_SHIFT, MAX_SHIFT)
    score = min(1.0, max(0.0, magnitude * improvement * agreement))
    return _MotionSample(timestamp_ms=0, shift=best_shift, score=score)


def _motion_metrics(samples: Sequence[_MotionSample]) -> BackImpactMetrics:
    candidate = samples[8]
    baseline = median(sample.score for sample in samples[:8])
    impulse = min(1.0, max(0.0, (candidate.score - baseline) / max(1.0 - baseline, 1e-9)))
    candidate_magnitude = math.hypot(candidate.shift.dx, candidate.shift.dy)
    recovery = 0.0
    cumulative_x, cumulative_y = candidate.shift.dx, candidate.shift.dy
    for sample in samples[9:13]:
        cumulative_x += sample.shift.dx
        cumulative_y += sample.shift.dy
        if candidate_magnitude > 0.0:
            return_score = 1.0 - math.hypot(cumulative_x, cumulative_y) / candidate_magnitude
            reverse_score = -(
                candidate.shift.dx * sample.shift.dx + candidate.shift.dy * sample.shift.dy
            ) / (candidate_magnitude * candidate_magnitude)
            recovery = max(recovery, return_score, reverse_score)
    return BackImpactMetrics(candidate.score, impulse, min(1.0, max(0.0, recovery)))


def analyze_back_frames(clip_id: str, frames: Iterable[GrayFrame]) -> BackImpactResult:
    window: deque[_MotionSample] = deque(maxlen=13)
    analyzed_frames = low_contrast_frames = first_timestamp = last_timestamp = 0
    previous_timestamp: int | None = None
    previous_pixels: bytes | None = None
    unsupported_video, timing_reliable = False, True
    best_metrics = BackImpactMetrics(0.0, 0.0, 0.0)
    candidate_metrics: BackImpactMetrics | None = None
    candidate_timestamp: int | None = None
    for frame in frames:
        analyzed_frames += 1
        if analyzed_frames == 1:
            first_timestamp = frame.timestamp_ms
        last_timestamp = frame.timestamp_ms
        if previous_timestamp is not None:
            interval = frame.timestamp_ms - previous_timestamp
            timing_reliable = timing_reliable and 62 <= interval <= 250
        previous_timestamp = frame.timestamp_ms
        if len(frame.pixels) != FRAME_WIDTH * FRAME_HEIGHT:
            unsupported_video = True
            previous_pixels = None
            continue
        low_contrast_frames += pstdev(frame.pixels[::64]) < MIN_CONTRAST
        if previous_pixels is not None:
            estimated = _estimate_translation(previous_pixels, frame.pixels)
            window.append(_MotionSample(frame.timestamp_ms, estimated.shift, estimated.score))
            if len(window) == 13:
                metrics = _motion_metrics(tuple(window))
                if metrics.impulse_score > best_metrics.impulse_score:
                    best_metrics = metrics
                if (
                    metrics.global_motion_score >= GLOBAL_MOTION_THRESHOLD
                    and metrics.impulse_score >= IMPULSE_THRESHOLD
                    and metrics.recovery_score >= RECOVERY_THRESHOLD
                    and (
                        candidate_metrics is None
                        or metrics.global_motion_score > candidate_metrics.global_motion_score
                    )
                ):
                    candidate_metrics = metrics
                    candidate_timestamp = window[8].timestamp_ms
        previous_pixels = frame.pixels
    duration_ms = max(0, last_timestamp - first_timestamp)
    checks: tuple[tuple[bool, BackImpactIssue], ...] = (
        (unsupported_video, "unsupported_video"),
        (analyzed_frames < MIN_FRAMES, "insufficient_frames"),
        (not timing_reliable, "frame_timing_unreliable"),
        (analyzed_frames > 0 and low_contrast_frames * 2 >= analyzed_frames, "low_visibility"),
    )
    issues: tuple[BackImpactIssue, ...] = tuple(issue for failed, issue in checks if failed)
    make_result = partial(BackImpactResult, duration_ms, analyzed_frames)

    if issues:
        return make_result(None, clip_id, issues, None, "indeterminate")
    if candidate_metrics is not None and candidate_timestamp is not None:
        relative_candidate = candidate_timestamp - first_timestamp
        return make_result(relative_candidate, clip_id, (), candidate_metrics, "possible_contact")
    return make_result(None, clip_id, (), best_metrics, "no_impact_signal_observed")
