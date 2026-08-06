from __future__ import annotations

from collections.abc import Iterable

from .camera_activity import (
    CameraActivityIssue,
    CameraActivityMetrics,
    CameraActivityResult,
    KnownCamera,
)
from .near_camera_activity import NearCameraActivityDetector
from .temporal_activity import GrayFrame, TemporalAnalysisConfig, analyze_temporal_frames


def analyze_camera_frames(
    camera: KnownCamera,
    clip_id: str,
    frames: Iterable[GrayFrame],
) -> CameraActivityResult:
    detector = NearCameraActivityDetector(160, 104)
    config = TemporalAnalysisConfig(104, 160, 250, 12.0, 24, 62)
    summary = analyze_temporal_frames(frames, config, detector.observe)
    issues: tuple[CameraActivityIssue, ...] = summary.issues
    if issues:
        return CameraActivityResult(
            summary.duration_ms,
            summary.analyzed_frames,
            camera,
            None,
            clip_id,
            issues,
            None,
            "indeterminate",
        )
    selected = detector.candidate or detector.occlusion_candidate
    sample = selected or detector.best_sample
    occlusion = detector.best_occlusion_sample
    metrics = CameraActivityMetrics(
        sample.changed_pixel_ratio,
        sample.gradient_change_ratio,
        sample.near_camera_score,
        detector.qualifying_samples,
        occlusion.flat_ratio,
        detector.occlusion_qualifying_samples,
        occlusion.occlusion_score,
    )
    if selected is not None:
        candidate_timestamp = selected.timestamp_ms - summary.analysis_start_ms
        return CameraActivityResult(
            summary.duration_ms,
            summary.analyzed_frames,
            camera,
            candidate_timestamp,
            clip_id,
            (),
            metrics,
            "activity_detected",
        )
    return CameraActivityResult(
        summary.duration_ms,
        summary.analyzed_frames,
        camera,
        None,
        clip_id,
        (),
        metrics,
        "no_activity_signal_observed",
    )
