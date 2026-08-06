from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Final

PIXEL_DIFFERENCE_THRESHOLD: Final = 72
GRADIENT_DIFFERENCE_THRESHOLD: Final = 64
CHANGED_PIXEL_REFERENCE: Final = 0.08
GRADIENT_CHANGE_REFERENCE: Final = 0.10
ACTIVITY_THRESHOLD: Final = 0.70
PERSISTENCE_WINDOW: Final = 4
MINIMUM_QUALIFYING_SAMPLES: Final = 2
FLAT_GRADIENT_THRESHOLD: Final = 40
OCCLUSION_CHANGED_REFERENCE: Final = 0.08
OCCLUSION_FLAT_REFERENCE: Final = 0.50
OCCLUSION_SCORE_THRESHOLD: Final = 0.50
MIN_OCCLUSION_CHANGED_RATIO: Final = 0.04
MAX_OCCLUSION_CHANGED_RATIO: Final = 0.80
MIN_FLAT_RATIO: Final = 0.40
MAX_BBOX_RATIO: Final = 0.85


@dataclass(frozen=True, slots=True)
class NearCameraSample:
    timestamp_ms: int
    changed_pixel_ratio: float
    gradient_change_ratio: float
    near_camera_score: float
    flat_ratio: float
    bbox_ratio: float
    occlusion_score: float


def measure_near_camera_change(
    timestamp_ms: int,
    previous: bytes,
    current: bytes,
    frame_width: int,
    frame_height: int,
) -> NearCameraSample:
    frame_pixels = frame_width * frame_height
    changed = [
        index
        for index in range(frame_pixels)
        if abs(previous[index] - current[index]) >= PIXEL_DIFFERENCE_THRESHOLD
    ]
    changed_count = len(changed)
    changed_lookup = frozenset(changed)
    gradient_changes = 0
    flat_changes = 0
    gradient_count = (frame_width - 2) * (frame_height - 2)
    for y in range(1, frame_height - 1):
        for x in range(1, frame_width - 1):
            index = y * frame_width + x
            previous_gradient = abs(previous[index + 1] - previous[index - 1]) + abs(
                previous[index + frame_width] - previous[index - frame_width]
            )
            current_gradient = abs(current[index + 1] - current[index - 1]) + abs(
                current[index + frame_width] - current[index - frame_width]
            )
            if abs(previous_gradient - current_gradient) >= GRADIENT_DIFFERENCE_THRESHOLD:
                gradient_changes += 1
            if (
                index in changed_lookup
                and previous_gradient < FLAT_GRADIENT_THRESHOLD
                and current_gradient < FLAT_GRADIENT_THRESHOLD
            ):
                flat_changes += 1
    changed_ratio = changed_count / frame_pixels
    gradient_ratio = gradient_changes / gradient_count
    score = min(
        1.0,
        changed_ratio / CHANGED_PIXEL_REFERENCE,
        gradient_ratio / GRADIENT_CHANGE_REFERENCE,
    )
    if changed_count == 0:
        return NearCameraSample(timestamp_ms, changed_ratio, gradient_ratio, score, 0.0, 0.0, 0.0)
    flat_ratio = flat_changes / changed_count
    min_x = min(index % frame_width for index in changed)
    max_x = max(index % frame_width for index in changed)
    min_y = min(index // frame_width for index in changed)
    max_y = max(index // frame_width for index in changed)
    bbox_ratio = ((max_x - min_x + 1) * (max_y - min_y + 1)) / frame_pixels
    occlusion_score = 0.0
    if (
        MIN_OCCLUSION_CHANGED_RATIO <= changed_ratio <= MAX_OCCLUSION_CHANGED_RATIO
        and flat_ratio >= MIN_FLAT_RATIO
        and bbox_ratio <= MAX_BBOX_RATIO
    ):
        occlusion_score = min(
            1.0,
            changed_ratio / OCCLUSION_CHANGED_REFERENCE,
            flat_ratio / OCCLUSION_FLAT_REFERENCE,
        )
    return NearCameraSample(
        timestamp_ms, changed_ratio, gradient_ratio, score, flat_ratio, bbox_ratio, occlusion_score
    )


class NearCameraActivityDetector:
    def __init__(self, frame_width: int, frame_height: int) -> None:
        if frame_width < 3 or frame_height < 3:
            raise ValueError("invalid near camera dimensions")
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.window: deque[NearCameraSample] = deque(maxlen=PERSISTENCE_WINDOW)
        self.best_sample = NearCameraSample(0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        self.best_occlusion_sample = NearCameraSample(0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        self.candidate: NearCameraSample | None = None
        self.qualifying_samples = 0
        self.occlusion_candidate: NearCameraSample | None = None
        self.occlusion_qualifying_samples = 0

    def observe(self, timestamp_ms: int, previous: bytes, current: bytes) -> None:
        sample = measure_near_camera_change(
            timestamp_ms,
            previous,
            current,
            self.frame_width,
            self.frame_height,
        )
        self.window.append(sample)
        if sample.near_camera_score > self.best_sample.near_camera_score:
            self.best_sample = sample
        if sample.occlusion_score > self.best_occlusion_sample.occlusion_score:
            self.best_occlusion_sample = sample
        if sample.near_camera_score >= ACTIVITY_THRESHOLD:
            self.qualifying_samples += 1
        if sample.occlusion_score >= OCCLUSION_SCORE_THRESHOLD:
            self.occlusion_qualifying_samples += 1
        motion_qualifiers = tuple(
            item for item in self.window if item.near_camera_score >= ACTIVITY_THRESHOLD
        )
        if len(motion_qualifiers) >= MINIMUM_QUALIFYING_SAMPLES:
            window_candidate = max(motion_qualifiers, key=lambda item: item.near_camera_score)
            if (
                self.candidate is None
                or window_candidate.near_camera_score > self.candidate.near_camera_score
            ):
                self.candidate = window_candidate
        occlusion_qualifiers = tuple(
            item for item in self.window if item.occlusion_score >= OCCLUSION_SCORE_THRESHOLD
        )
        if len(occlusion_qualifiers) >= MINIMUM_QUALIFYING_SAMPLES:
            window_candidate = max(occlusion_qualifiers, key=lambda item: item.occlusion_score)
            if (
                self.occlusion_candidate is None
                or window_candidate.occlusion_score > self.occlusion_candidate.occlusion_score
            ):
                self.occlusion_candidate = window_candidate
