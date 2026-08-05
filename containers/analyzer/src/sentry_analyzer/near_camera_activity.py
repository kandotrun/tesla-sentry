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


@dataclass(frozen=True, slots=True)
class NearCameraSample:
    timestamp_ms: int
    changed_pixel_ratio: float
    gradient_change_ratio: float
    near_camera_score: float


def measure_near_camera_change(
    timestamp_ms: int,
    previous: bytes,
    current: bytes,
    frame_width: int,
    frame_height: int,
) -> NearCameraSample:
    changed_pixels = sum(
        abs(left - right) >= PIXEL_DIFFERENCE_THRESHOLD
        for left, right in zip(previous, current, strict=True)
    )
    gradient_changes = 0
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
            gradient_changes += (
                abs(previous_gradient - current_gradient) >= GRADIENT_DIFFERENCE_THRESHOLD
            )
    changed_ratio = changed_pixels / len(previous)
    gradient_ratio = gradient_changes / gradient_count
    score = min(
        1.0,
        changed_ratio / CHANGED_PIXEL_REFERENCE,
        gradient_ratio / GRADIENT_CHANGE_REFERENCE,
    )
    return NearCameraSample(timestamp_ms, changed_ratio, gradient_ratio, score)


class NearCameraActivityDetector:
    def __init__(self, frame_width: int, frame_height: int) -> None:
        if frame_width < 3 or frame_height < 3:
            raise ValueError("invalid near camera dimensions")
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.window: deque[NearCameraSample] = deque(maxlen=PERSISTENCE_WINDOW)
        self.best_sample = NearCameraSample(0, 0.0, 0.0, 0.0)
        self.candidate: NearCameraSample | None = None
        self.qualifying_samples = 0

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
        qualifiers = tuple(
            candidate
            for candidate in self.window
            if candidate.near_camera_score >= ACTIVITY_THRESHOLD
        )
        if sample.near_camera_score >= ACTIVITY_THRESHOLD:
            self.qualifying_samples += 1
        if len(qualifiers) < MINIMUM_QUALIFYING_SAMPLES:
            return
        window_candidate = max(qualifiers, key=lambda candidate: candidate.near_camera_score)
        if (
            self.candidate is None
            or window_candidate.near_camera_score > self.candidate.near_camera_score
        ):
            self.candidate = window_candidate
