from __future__ import annotations

import math
import re
from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass
from functools import partial
from typing import Final, Literal, TypedDict, assert_never

from .temporal_activity import GrayFrame, TemporalAnalysisConfig, analyze_temporal_frames
from .temporal_translation import (
    TranslationSample,
    estimate_translation,
    translation_metrics,
)

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


def analyze_back_frames(clip_id: str, frames: Iterable[GrayFrame]) -> BackImpactResult:
    window: deque[TranslationSample] = deque(maxlen=13)
    best_metrics = BackImpactMetrics(0.0, 0.0, 0.0)
    candidate_metrics: BackImpactMetrics | None = None
    candidate_timestamp: int | None = None

    def consume_transition(timestamp_ms: int, previous: bytes, current: bytes) -> None:
        nonlocal best_metrics, candidate_metrics, candidate_timestamp
        shift, score = estimate_translation(previous, current, FRAME_WIDTH, FRAME_HEIGHT, MAX_SHIFT)
        window.append(TranslationSample(timestamp_ms, shift, score))
        if len(window) != 13:
            return
        measured = translation_metrics(tuple(window))
        metrics = BackImpactMetrics(
            measured.global_motion_score,
            measured.impulse_score,
            measured.recovery_score,
        )
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

    config = TemporalAnalysisConfig(
        FRAME_HEIGHT,
        FRAME_WIDTH,
        250,
        MIN_CONTRAST,
        MIN_FRAMES,
        62,
    )
    summary = analyze_temporal_frames(frames, config, consume_transition)
    issues: tuple[BackImpactIssue, ...] = summary.issues
    make_result = partial(BackImpactResult, summary.duration_ms, summary.analyzed_frames)
    if issues:
        return make_result(None, clip_id, issues, None, "indeterminate")
    if candidate_metrics is not None and candidate_timestamp is not None:
        relative_candidate = candidate_timestamp - summary.analysis_start_ms
        return make_result(relative_candidate, clip_id, (), candidate_metrics, "possible_contact")
    return make_result(None, clip_id, (), best_metrics, "no_impact_signal_observed")
