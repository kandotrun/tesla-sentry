from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from statistics import median


@dataclass(frozen=True, slots=True)
class TranslationShift:
    dx: int
    dy: int


@dataclass(frozen=True, slots=True)
class TranslationSample:
    timestamp_ms: int
    shift: TranslationShift
    score: float


@dataclass(frozen=True, slots=True)
class TranslationMetrics:
    global_motion_score: float
    impulse_score: float
    recovery_score: float


def _gradient(pixels: bytes, index: int, frame_width: int) -> tuple[int, int]:
    horizontal = pixels[index + 1] - pixels[index - 1]
    vertical = pixels[index + frame_width] - pixels[index - frame_width]
    return horizontal, vertical


def _gradient_errors(
    previous: bytes,
    current: bytes,
    shift: TranslationShift,
    frame_width: int,
    frame_height: int,
) -> tuple[int, ...]:
    errors = [0, 0, 0, 0, 0]
    for y in range(8, frame_height - 8, 8):
        for x in range(8, frame_width - 8, 8):
            current_index = (y + shift.dy) * frame_width + x + shift.dx
            gradients = zip(
                _gradient(previous, y * frame_width + x, frame_width),
                _gradient(current, current_index, frame_width),
                strict=True,
            )
            difference = sum(
                abs(previous_value - current_value) for previous_value, current_value in gradients
            )
            region = 1 + int(x >= frame_width // 2) + 2 * int(y >= frame_height // 2)
            errors[0] += difference
            errors[region] += difference
    return tuple(errors)


def estimate_translation(
    previous: bytes,
    current: bytes,
    frame_width: int,
    frame_height: int,
    maximum_shift: int,
) -> tuple[TranslationShift, float]:
    zero_errors = _gradient_errors(
        previous,
        current,
        TranslationShift(0, 0),
        frame_width,
        frame_height,
    )
    best_shift = TranslationShift(0, 0)
    best_errors = zero_errors
    for dy in range(-maximum_shift, maximum_shift + 1):
        for dx in range(-maximum_shift, maximum_shift + 1):
            shift = TranslationShift(dx, dy)
            errors = _gradient_errors(previous, current, shift, frame_width, frame_height)
            if errors[0] < best_errors[0]:
                best_shift = shift
                best_errors = errors
    improvement = 0.0
    if zero_errors[0] > 0.0:
        improvement = (zero_errors[0] - best_errors[0]) / zero_errors[0]
    agreement = sum(best_errors[index] < zero_errors[index] for index in range(1, 5)) / 4
    magnitude = math.hypot(best_shift.dx, best_shift.dy) / math.hypot(maximum_shift, maximum_shift)
    score = min(1.0, max(0.0, magnitude * improvement * agreement))
    return best_shift, score


def translation_metrics(samples: Sequence[TranslationSample]) -> TranslationMetrics:
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
    return TranslationMetrics(candidate.score, impulse, min(1.0, max(0.0, recovery)))
