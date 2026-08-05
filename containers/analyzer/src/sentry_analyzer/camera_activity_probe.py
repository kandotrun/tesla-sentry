from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Final

from .back_impact_probe import ProbeMetadata
from .camera_activity import KnownCamera


@dataclass(frozen=True, slots=True)
class CameraMediaProfile:
    coded_height: int
    coded_width: int
    crop: tuple[int, int, int, int]
    height: int
    width: int


FRONT_PROFILE: Final = CameraMediaProfile(1888, 2896, (0, 12, 0, 0), 1876, 2896)
STANDARD_PROFILE: Final = CameraMediaProfile(944, 1456, (0, 6, 0, 8), 938, 1448)


def profile_for_camera(camera: KnownCamera) -> CameraMediaProfile:
    return FRONT_PROFILE if camera == "front" else STANDARD_PROFILE


def probe_is_supported_for_camera(camera: KnownCamera, probe: ProbeMetadata) -> bool:
    profile = profile_for_camera(camera)
    return (
        probe.codec_name == "h264"
        and probe.coded_width == profile.coded_width
        and probe.coded_height == profile.coded_height
        and probe.width == profile.width
        and probe.height == profile.height
        and probe.crop == profile.crop
        and 3.0 <= probe.duration_seconds <= 90.0
        and Fraction(1) <= probe.frame_rate <= Fraction(120)
        and probe.rotation == 0
    )
