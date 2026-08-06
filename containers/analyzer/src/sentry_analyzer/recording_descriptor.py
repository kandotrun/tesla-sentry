from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from .anchor_extraction import AnchorMeasurement, extract_anchor_measurements
from .camera_activity import KnownCamera
from .temporal_activity import GrayFrame

ANCHOR_TOLERANCE: Final = 0.01


@dataclass(frozen=True, slots=True)
class CameraRecordingDescriptor:
    anchor_error_normalized: float | None
    camera: KnownCamera
    codec: str
    cropped: bool
    height: int
    rotation_degrees: int
    width: int


def _max_anchor_error(measurements: tuple[AnchorMeasurement, ...]) -> float:
    return max(m.error_normalized for m in measurements)


def generate_recording_descriptors(
    camera: KnownCamera,
    codec: str,
    height: int,
    width: int,
    cropped: bool,
    rotation_degrees: int,
    anchor_frame: GrayFrame | None,
) -> CameraRecordingDescriptor:
    anchor_error: float | None = None
    if anchor_frame is not None:
        measurements = extract_anchor_measurements(camera, anchor_frame)
        if measurements is not None:
            anchor_error = _max_anchor_error(measurements)
    return CameraRecordingDescriptor(
        anchor_error, camera, codec, cropped, height, rotation_degrees, width,
    )


__all__ = [
    "CameraRecordingDescriptor",
    "generate_recording_descriptors",
]
