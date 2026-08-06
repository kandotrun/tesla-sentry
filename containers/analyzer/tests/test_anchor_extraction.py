from __future__ import annotations

import math

from sentry_analyzer.anchor_extraction import (
    DIAGONAL_PX,
    LEFT_REPEATER_ANCHORS,
    RIGHT_REPEATER_ANCHORS,
    extract_anchor_measurements,
)
from sentry_analyzer.temporal_activity import GrayFrame


def _make_frame(pixels: bytes | None = None) -> GrayFrame:
    if pixels is None:
        pixels = bytes(1448 * 938)
    return GrayFrame(0, pixels)


def _make_gradient_frame(dark_left: bool) -> GrayFrame:
    pixels = bytearray(1448 * 938)
    for y in range(938):
        row = y * 1448
        for x in range(1448):
            if dark_left:
                pixels[row + x] = 30 if x < 100 else 200
            else:
                pixels[row + x] = 200 if x < 1348 else 30
    return GrayFrame(0, bytes(pixels))


def test_returns_none_for_non_repeater_cameras() -> None:
    for camera in ("front", "back", "left_pillar", "right_pillar"):
        assert extract_anchor_measurements(camera, _make_frame()) is None


def test_returns_none_for_wrong_frame_size() -> None:
    frame = GrayFrame(0, bytes(100))
    assert extract_anchor_measurements("left_repeater", frame) is None


def test_extracts_left_repeater_anchors() -> None:
    frame = _make_gradient_frame(dark_left=True)
    result = extract_anchor_measurements("left_repeater", frame)
    assert result is not None
    assert len(result) == 2
    assert result[0].anchor_id == "A"
    assert result[1].anchor_id == "B"


def test_extracts_right_repeater_anchors() -> None:
    frame = _make_gradient_frame(dark_left=False)
    result = extract_anchor_measurements("right_repeater", frame)
    assert result is not None
    assert len(result) == 2
    assert result[0].anchor_id == "A"
    assert result[1].anchor_id == "B"


def test_anchor_error_is_finite_and_nonnegative() -> None:
    frame = _make_gradient_frame(dark_left=True)
    result = extract_anchor_measurements("left_repeater", frame)
    assert result is not None
    for m in result:
        assert math.isfinite(m.error_normalized)
        assert m.error_normalized >= 0.0


def test_anchor_error_normalized_by_diagonal() -> None:
    frame = _make_gradient_frame(dark_left=True)
    result = extract_anchor_measurements("left_repeater", frame)
    assert result is not None
    for m in result:
        expected_error = abs(m.found_y_px - round(m.expected.normalized_y * 938)) / DIAGONAL_PX
        assert m.error_normalized == expected_error


def test_anchor_found_y_within_search_radius() -> None:
    frame = _make_gradient_frame(dark_left=True)
    result = extract_anchor_measurements("left_repeater", frame)
    assert result is not None
    for m in result:
        expected_y = round(m.expected.normalized_y * 938)
        assert abs(m.found_y_px - expected_y) <= 30


def test_anchor_positions_match_profile() -> None:
    assert len(LEFT_REPEATER_ANCHORS) == 2
    assert len(RIGHT_REPEATER_ANCHORS) == 2
    for anchor in LEFT_REPEATER_ANCHORS:
        assert 0.0 <= anchor.normalized_x <= 1.0
        assert 0.0 <= anchor.normalized_y <= 1.0
    for anchor in RIGHT_REPEATER_ANCHORS:
        assert 0.0 <= anchor.normalized_x <= 1.0
        assert 0.0 <= anchor.normalized_y <= 1.0
