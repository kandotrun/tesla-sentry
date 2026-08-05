from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol

from .back_impact_io import InputHandle
from .back_impact_media import (
    PROCESS_DEADLINE_SECONDS,
    FFmpegBackImpactMedia,
    MediaProcessError,
)
from .back_impact_probe import MediaIssue
from .camera_activity import KnownCamera
from .camera_activity_probe import probe_is_supported_for_camera
from .temporal_activity import GrayFrame


class CameraActivityMedia(Protocol):
    def stream_frames(self, input_handle: InputHandle) -> Iterable[GrayFrame]: ...


class FFmpegCameraActivityMedia(FFmpegBackImpactMedia):
    camera: KnownCamera

    def __init__(
        self,
        camera: KnownCamera,
        ffmpeg_binary: str = "ffmpeg",
        ffprobe_binary: str = "ffprobe",
        deadline_seconds: float = PROCESS_DEADLINE_SECONDS,
    ) -> None:
        super().__init__(ffmpeg_binary, ffprobe_binary, deadline_seconds)
        self.camera = camera

    def stream_frames(self, input_handle: InputHandle) -> Iterable[GrayFrame]:
        if not probe_is_supported_for_camera(self.camera, self._probe(input_handle)):
            raise MediaIssue("unsupported_video")
        yield from self._decode(input_handle)


__all__ = ["CameraActivityMedia", "FFmpegCameraActivityMedia", "MediaProcessError"]
