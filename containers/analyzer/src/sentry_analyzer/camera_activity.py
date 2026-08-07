from __future__ import annotations

import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Final, Literal, TypedDict, assert_never

from .temporal_activity import GrayFrame

SCHEMA_VERSION: Final = 1
ANALYZER_VERSION: Final = "camera-temporal-activity-v3"
SOURCE: Final = "camera_temporal_activity"
SAFE_IDENTIFIER: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

KnownCamera = Literal[
    "front",
    "back",
    "left_repeater",
    "right_repeater",
    "left_pillar",
    "right_pillar",
]
CAMERA_ACTIVITY_ORDER: Final[tuple[KnownCamera, ...]] = (
    "front",
    "back",
    "left_repeater",
    "right_repeater",
    "left_pillar",
    "right_pillar",
)
CameraActivityIssue = (
    Literal["analysis_failed", "decode_failed", "frame_timing_unreliable"]
    | Literal["insufficient_frames", "low_visibility", "unsupported_video"]
)
CameraActivityStatus = Literal["activity_detected", "no_activity_signal_observed", "indeterminate"]
ALLOWED_ISSUES: Final[tuple[CameraActivityIssue, ...]] = (
    *("analysis_failed", "decode_failed", "frame_timing_unreliable"),
    "insufficient_frames",
    "low_visibility",
    "unsupported_video",
)


class CameraActivityMetricsPayload(TypedDict):
    changedPixelRatio: float
    gradientChangeRatio: float
    nearCameraScore: float
    occlusionFlatRatio: float
    occlusionQualifyingSamples: int
    occlusionScore: float
    qualifyingSamples: int


class CameraActivityResultPayload(TypedDict):
    analysisDurationMs: int
    analyzedFrames: int
    analyzerVersion: Literal["camera-temporal-activity-v3"]
    camera: KnownCamera
    candidateTimestampMs: int | None
    clipId: str
    issues: list[CameraActivityIssue]
    metrics: CameraActivityMetricsPayload | None
    schemaVersion: Literal[1]
    source: Literal["camera_temporal_activity"]
    status: CameraActivityStatus


class CameraActivityEventPayload(TypedDict):
    analyzerVersion: Literal["camera-temporal-activity-v3"]
    cameras: list[CameraActivityResultPayload]
    eventId: str
    schemaVersion: Literal[1]
    source: Literal["camera_temporal_activity"]
    status: CameraActivityStatus


@dataclass(frozen=True, slots=True)
class CameraActivityResultError(ValueError):
    field: str

    def __str__(self) -> str:
        return f"invalid camera activity result field: {self.field}"


def _safe_integer(value: int) -> bool:
    return type(value) is int and 0 <= value <= 2**53 - 1


@dataclass(frozen=True, slots=True)
class CameraActivityMetrics:
    changed_pixel_ratio: float
    gradient_change_ratio: float
    near_camera_score: float
    qualifying_samples: int
    occlusion_flat_ratio: float
    occlusion_qualifying_samples: int
    occlusion_score: float

    def is_valid(self) -> bool:
        scores = (
            self.changed_pixel_ratio,
            self.gradient_change_ratio,
            self.near_camera_score,
            self.occlusion_flat_ratio,
            self.occlusion_score,
        )
        return all(math.isfinite(score) and 0.0 <= score <= 1.0 for score in scores) and all(
            _safe_integer(count)
            for count in (self.qualifying_samples, self.occlusion_qualifying_samples)
        )

    def to_dict(self) -> CameraActivityMetricsPayload:
        return {
            "changedPixelRatio": round(self.changed_pixel_ratio, 6),
            "gradientChangeRatio": round(self.gradient_change_ratio, 6),
            "nearCameraScore": round(self.near_camera_score, 6),
            "occlusionFlatRatio": round(self.occlusion_flat_ratio, 6),
            "occlusionQualifyingSamples": self.occlusion_qualifying_samples,
            "occlusionScore": round(self.occlusion_score, 6),
            "qualifyingSamples": self.qualifying_samples,
        }


@dataclass(frozen=True, slots=True)
class CameraActivityResult:
    analysis_duration_ms: int
    analyzed_frames: int
    camera: KnownCamera
    candidate_timestamp_ms: int | None
    clip_id: str
    issues: tuple[CameraActivityIssue, ...]
    metrics: CameraActivityMetrics | None
    status: CameraActivityStatus

    def __post_init__(self) -> None:
        if not all(map(_safe_integer, (self.analysis_duration_ms, self.analyzed_frames))):
            raise CameraActivityResultError("integer")
        if self.camera not in CAMERA_ACTIVITY_ORDER:
            raise CameraActivityResultError("camera")
        if SAFE_IDENTIFIER.fullmatch(self.clip_id) is None:
            raise CameraActivityResultError("clip_id")
        candidate = self.candidate_timestamp_ms
        if candidate is not None and (
            not _safe_integer(candidate) or candidate > self.analysis_duration_ms
        ):
            raise CameraActivityResultError("candidate_timestamp_ms")
        if self.metrics is not None and not self.metrics.is_valid():
            raise CameraActivityResultError("metrics")
        match self.status:
            case "activity_detected":
                valid = candidate is not None and self.metrics is not None and not self.issues
            case "no_activity_signal_observed":
                valid = candidate is None and self.metrics is not None and not self.issues
            case "indeterminate":
                valid = (
                    candidate is None
                    and self.metrics is None
                    and bool(self.issues)
                    and all(issue in ALLOWED_ISSUES for issue in self.issues)
                )
            case _:
                assert_never(self.status)
        if not valid:
            raise CameraActivityResultError("status")

    def to_dict(self) -> CameraActivityResultPayload:
        return {
            "analysisDurationMs": self.analysis_duration_ms,
            "analyzedFrames": self.analyzed_frames,
            "analyzerVersion": ANALYZER_VERSION,
            "camera": self.camera,
            "candidateTimestampMs": self.candidate_timestamp_ms,
            "clipId": self.clip_id,
            "issues": list(self.issues),
            "metrics": None if self.metrics is None else self.metrics.to_dict(),
            "schemaVersion": SCHEMA_VERSION,
            "source": SOURCE,
            "status": self.status,
        }


@dataclass(frozen=True, slots=True)
class CameraActivityEventResult:
    event_id: str
    cameras: tuple[CameraActivityResult, ...]
    status: CameraActivityStatus

    def __post_init__(self) -> None:
        if SAFE_IDENTIFIER.fullmatch(self.event_id) is None:
            raise CameraActivityResultError("event_id")
        if tuple(result.camera for result in self.cameras) != CAMERA_ACTIVITY_ORDER:
            raise CameraActivityResultError("cameras")
        expected = _aggregate_status(self.cameras)
        if self.status != expected:
            raise CameraActivityResultError("status")

    def to_dict(self) -> CameraActivityEventPayload:
        return {
            "analyzerVersion": ANALYZER_VERSION,
            "cameras": [result.to_dict() for result in self.cameras],
            "eventId": self.event_id,
            "schemaVersion": SCHEMA_VERSION,
            "source": SOURCE,
            "status": self.status,
        }


def _aggregate_status(cameras: tuple[CameraActivityResult, ...]) -> CameraActivityStatus:
    if any(result.status == "activity_detected" for result in cameras):
        return "activity_detected"
    if any(result.status == "indeterminate" for result in cameras):
        return "indeterminate"
    return "no_activity_signal_observed"


def aggregate_camera_activity(
    event_id: str,
    cameras: tuple[CameraActivityResult, ...],
) -> CameraActivityEventResult:
    return CameraActivityEventResult(event_id, cameras, _aggregate_status(cameras))


def analyze_camera_frames(
    camera: KnownCamera,
    clip_id: str,
    frames: Iterable[GrayFrame],
) -> CameraActivityResult:
    from .camera_activity_analysis import analyze_camera_frames as analyze

    return analyze(camera, clip_id, frames)
