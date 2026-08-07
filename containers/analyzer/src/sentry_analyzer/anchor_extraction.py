from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final

from .camera_activity import KnownCamera
from .temporal_activity import GrayFrame

ANCHOR_SEARCH_RADIUS_PX: Final = 30
ANCHOR_FLANK_HALF_WIDTH: Final = 8
ANCHOR_CENTER_HALF_WIDTH: Final = 2
ANCHOR_SLICE_HALF_HEIGHT: Final = 2
DIAGONAL_PX: Final = math.hypot(1448, 938)


@dataclass(frozen=True, slots=True)
class AnchorPosition:
    normalized_x: float
    normalized_y: float


@dataclass(frozen=True, slots=True)
class AnchorMeasurement:
    anchor_id: str
    expected: AnchorPosition
    found_y_px: int
    error_normalized: float


LEFT_REPEATER_ANCHORS: Final = (
    AnchorPosition(0.042818, 0.660981),
    AnchorPosition(0.051796, 0.799574),
)

RIGHT_REPEATER_ANCHORS: Final = (
    AnchorPosition(0.953729, 0.623667),
    AnchorPosition(0.938536, 0.815565),
)

ANCHOR_LABELS: Final = ("A", "B")


def _pixel_x(normalized_x: float) -> int:
    return round(normalized_x * 1448)


def _pixel_y(normalized_y: float) -> int:
    return round(normalized_y * 938)


def _slice_luma(
    pixels: bytes,
    frame_width: int,
    x_center: int,
    y_center: int,
    half_width: int,
    half_height: int,
) -> float:
    total = 0
    count = 0
    x_start = max(0, x_center - half_width)
    x_end = min(frame_width, x_center + half_width + 1)
    y_start = max(0, y_center - half_height)
    y_end = min(938, y_center + half_height + 1)
    for y in range(y_start, y_end):
        row_offset = y * frame_width
        for x in range(x_start, x_end):
            total += pixels[row_offset + x]
            count += 1
    return total / count if count > 0 else 0.0


def _measure_anchor_y(
    pixels: bytes,
    frame_width: int,
    anchor_x_px: int,
    anchor_y_px: int,
    car_body_on_left: bool,
) -> int:
    best_y = anchor_y_px
    best_score = float("-inf")
    y_start = max(0, anchor_y_px - ANCHOR_SEARCH_RADIUS_PX)
    y_end = min(938, anchor_y_px + ANCHOR_SEARCH_RADIUS_PX + 1)
    for y in range(y_start, y_end):
        if car_body_on_left:
            car_body_mean = _slice_luma(
                pixels,
                frame_width,
                anchor_x_px - ANCHOR_FLANK_HALF_WIDTH,
                y,
                ANCHOR_FLANK_HALF_WIDTH,
                ANCHOR_SLICE_HALF_HEIGHT,
            )
            outside_mean = _slice_luma(
                pixels,
                frame_width,
                anchor_x_px + ANCHOR_FLANK_HALF_WIDTH,
                y,
                ANCHOR_FLANK_HALF_WIDTH,
                ANCHOR_SLICE_HALF_HEIGHT,
            )
            score = outside_mean - car_body_mean
        else:
            outside_mean = _slice_luma(
                pixels,
                frame_width,
                anchor_x_px - ANCHOR_FLANK_HALF_WIDTH,
                y,
                ANCHOR_FLANK_HALF_WIDTH,
                ANCHOR_SLICE_HALF_HEIGHT,
            )
            car_body_mean = _slice_luma(
                pixels,
                frame_width,
                anchor_x_px + ANCHOR_FLANK_HALF_WIDTH,
                y,
                ANCHOR_FLANK_HALF_WIDTH,
                ANCHOR_SLICE_HALF_HEIGHT,
            )
            score = outside_mean - car_body_mean
        if score > best_score:
            best_score = score
            best_y = y
    return best_y


def extract_anchor_measurements(
    camera: KnownCamera,
    frame: GrayFrame,
) -> tuple[AnchorMeasurement, ...] | None:
    if camera not in ("left_repeater", "right_repeater"):
        return None
    frame_width = 1448
    if len(frame.pixels) != frame_width * 938:
        return None
    anchors = LEFT_REPEATER_ANCHORS if camera == "left_repeater" else RIGHT_REPEATER_ANCHORS
    car_body_on_left = camera == "left_repeater"
    results: list[AnchorMeasurement] = []
    for index, anchor in enumerate(anchors):
        anchor_x_px = _pixel_x(anchor.normalized_x)
        anchor_y_px = _pixel_y(anchor.normalized_y)
        found_y = _measure_anchor_y(
            frame.pixels,
            frame_width,
            anchor_x_px,
            anchor_y_px,
            car_body_on_left,
        )
        error_px = abs(found_y - anchor_y_px)
        error_normalized = error_px / DIAGONAL_PX
        results.append(
            AnchorMeasurement(ANCHOR_LABELS[index], anchor, found_y, error_normalized),
        )
    return tuple(results)


__all__ = [
    "DIAGONAL_PX",
    "AnchorMeasurement",
    "AnchorPosition",
    "extract_anchor_measurements",
]
