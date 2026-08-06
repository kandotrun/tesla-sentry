from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from contextlib import ExitStack
from pathlib import Path
from typing import Final, TypedDict

from .back_impact_io import InputHandle, open_input, open_output
from .back_impact_media import FFmpegBackImpactMedia, MediaProcessError
from .back_impact_probe import MediaIssue
from .camera_activity_cli import ContractError, parse_request
from .camera_activity_probe import profile_for_camera
from .recording_descriptor import generate_recording_descriptors
from .temporal_activity import GrayFrame

MAX_REQUEST_BYTES: Final = 1024 * 1024
FULL_FRAME_WIDTH: Final = 1448
FULL_FRAME_HEIGHT: Final = 938
FULL_FRAME_BYTES: Final = FULL_FRAME_WIDTH * FULL_FRAME_HEIGHT


class RecordingDescriptorPayload(TypedDict):
    anchorErrorNormalized: float | None
    camera: str
    codec: str
    cropped: bool
    height: int
    rotationDegrees: int
    width: int


class RecordingDescriptorResultPayload(TypedDict):
    cameras: list[RecordingDescriptorPayload]
    eventId: str
    schemaVersion: int


def _capture_full_midpoint_frame(
    input_handle: InputHandle,
) -> GrayFrame | None:
    media = FFmpegBackImpactMedia()
    try:
        if not _probe_passes(media, input_handle):
            return None
    except MediaIssue:
        return None
    frames = list(_decode_full(media, input_handle))
    if not frames:
        return None
    midpoint = len(frames) // 2
    return frames[midpoint]


def _probe_passes(media: FFmpegBackImpactMedia, input_handle: InputHandle) -> bool:
    probe = media._probe(input_handle)
    return (
        probe.codec_name == "h264"
        and probe.coded_width == 1456
        and probe.coded_height == 944
        and probe.width == FULL_FRAME_WIDTH
        and probe.height == FULL_FRAME_HEIGHT
        and probe.rotation == 0
    )


def _decode_full(
    media: FFmpegBackImpactMedia,
    input_handle: InputHandle,
):
    import io
    import os
    import selectors
    import subprocess
    import time

    input_handle.rewind()
    arguments = [
        media.ffmpeg_binary,
        *("-hide_banner", "-loglevel", "error", "-nostdin"),
        *("-protocol_whitelist", "file", "-f", "mov", "-i"),
        input_handle.process_path(),
        *("-map", "0:v:0", "-vf"),
        "fps=8,format=gray",
        *("-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"),
    ]
    try:
        process = subprocess.Popen(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=media.environment,
            pass_fds=(input_handle.fileno(),),
        )
    except (FileNotFoundError, OSError) as error:
        raise MediaProcessError("decode") from error

    if process.stdout is None or process.stderr is None:
        media._stop(process)
        raise MediaProcessError("pipes")
    frame = bytearray()
    frame_index = 0
    deadline = time.monotonic() + media.deadline_seconds
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                media._stop(process)
                raise MediaIssue("analysis_failed")
            for key, _ in selector.select(min(remaining, 0.25)):
                size = FULL_FRAME_BYTES - len(frame) if key.data == "stdout" else 65536
                chunk = os.read(key.fd, size)
                if not chunk:
                    selector.unregister(key.fileobj)
                elif key.data == "stdout":
                    frame.extend(chunk)
                    if len(frame) == FULL_FRAME_BYTES:
                        yield GrayFrame(frame_index * 125, bytes(frame))
                        frame.clear()
                        frame_index += 1
        return_code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
    except (OSError, subprocess.TimeoutExpired) as error:
        media._stop(process)
        raise MediaProcessError("stream") from error
    finally:
        selector.close()
        if process.poll() is None:
            media._stop(process)
        process.stdout.close()
        process.stderr.close()
    if return_code != 0 or frame:
        raise MediaIssue("decode_failed")


def execute_request(
    request: object,
    input_root: Path,
    output_root: Path,
) -> list[RecordingDescriptorPayload]:
    with ExitStack() as stack:
        try:
            handles = tuple(
                stack.enter_context(open_input(input_root, item.relative_path))
                for item in request.cameras
            )
            if len({handle.identity.object_key() for handle in handles}) != len(handles):
                raise ContractError("cameras")
            output_handle = stack.enter_context(open_output(output_root))
        except OSError as error:
            raise ContractError("path") from error

        descriptors: list[RecordingDescriptorPayload] = []
        for item, handle in zip(request.cameras, handles, strict=True):
            profile = profile_for_camera(item.camera)
            anchor_frame = None
            if item.camera in ("left_repeater", "right_repeater"):
                anchor_frame = _capture_full_midpoint_frame(handle)
            descriptor = generate_recording_descriptors(
                item.camera,
                "h264",
                profile.height,
                profile.width,
                True,
                0,
                anchor_frame,
            )
            descriptors.append({
                "anchorErrorNormalized": descriptor.anchor_error_normalized,
                "camera": descriptor.camera,
                "codec": descriptor.codec,
                "cropped": descriptor.cropped,
                "height": descriptor.height,
                "rotationDegrees": descriptor.rotation_degrees,
                "width": descriptor.width,
            })

        for handle in handles:
            handle.verify_unchanged()
        output_handle.verify_attached()

        result: RecordingDescriptorResultPayload = {
            "cameras": descriptors,
            "eventId": request.event_id,
            "schemaVersion": 1,
        }
        serialized = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        output_handle.write(
            (serialized + "\n").encode(),
            lambda: all(handle.verify_unchanged() for handle in handles),
        )
        return descriptors


def _read_request(path: Path) -> dict:
    try:
        with path.open("rb") as request_file:
            raw = request_file.read(MAX_REQUEST_BYTES + 1)
    except OSError as error:
        raise ContractError("request") from error
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        raise ContractError("request")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError("request") from error
    if not isinstance(payload, dict):
        raise ContractError("request")
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate recording descriptors for a six-camera TeslaCam event.",
    )
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        request = parse_request(_read_request(arguments.request))
        descriptors = execute_request(request, arguments.input_root, arguments.output_root)
    except ContractError:
        message = '{"error":{"code":"invalid_request","message":"The request is invalid."}}'
        print(message, file=sys.stderr)
        return 2
    except (MediaProcessError, OSError, ValueError):
        print(
            '{"error":{"code":"processing_error","message":"Analysis failed."}}',
            file=sys.stderr,
        )
        return 5
    repeater_anchors = sum(
        1 for d in descriptors if d["camera"] in ("left_repeater", "right_repeater")
        and d["anchorErrorNormalized"] is not None
    )
    summary = json.dumps({
        "cameras": len(descriptors),
        "repeaterAnchorsExtracted": repeater_anchors,
    })
    print(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
