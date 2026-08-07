from __future__ import annotations

import io
import json
import os
import selectors
import shutil
import subprocess
import time
from collections.abc import Generator, Iterable
from typing import Final, Protocol

from .back_impact import FRAME_HEIGHT, FRAME_WIDTH, GrayFrame
from .back_impact_io import InputHandle
from .back_impact_probe import (
    TRACE_LIMIT_BYTES,
    JsonValue,
    MediaIssue,
    ProbeMetadata,
    parse_probe_payload,
    parse_sps_trace,
    probe_is_supported,
)

FRAME_BYTES: Final = FRAME_WIDTH * FRAME_HEIGHT
CAPTURE_CHUNK_BYTES: Final = 65_536
PROCESS_DEADLINE_SECONDS: Final = 120.0


class MediaProcessError(Exception):
    operation: str
    __slots__ = ("operation",)

    def __init__(self, operation: str) -> None:
        super().__init__("media process failed")
        self.operation = operation

    def __str__(self) -> str:
        return "media process failed"


class BackImpactMedia(Protocol):
    def stream_frames(self, input_handle: InputHandle) -> Iterable[GrayFrame]: ...


class FFmpegBackImpactMedia:
    def __init__(
        self,
        ffmpeg_binary: str = "ffmpeg",
        ffprobe_binary: str = "ffprobe",
        deadline_seconds: float = PROCESS_DEADLINE_SECONDS,
    ) -> None:
        self.ffmpeg_binary = shutil.which(ffmpeg_binary) or ffmpeg_binary
        self.ffprobe_binary = shutil.which(ffprobe_binary) or ffprobe_binary
        self.deadline_seconds = deadline_seconds
        self.environment = {"LANG": "C", "LC_ALL": "C", "PATH": os.defpath}

    def probe(self, input_handle: InputHandle) -> ProbeMetadata:
        sps_crop = self._trace_sps(input_handle)
        payload = self._run_probe(
            input_handle,
            "format=duration:stream=codec_name,width,height,coded_width,coded_height,avg_frame_rate,duration:stream_tags=rotate:stream_side_data=rotation:frame=width,height,crop_top,crop_bottom,crop_left,crop_right",
            True,
        )
        return parse_probe_payload(payload, sps_crop)

    def _trace_sps(self, input_handle: InputHandle) -> tuple[int, int, int, int]:
        input_handle.rewind()
        arguments = [
            self.ffmpeg_binary,
            *("-hide_banner", "-loglevel", "info", "-nostdin"),
            *("-protocol_whitelist", "file", "-f", "mov", "-i"),
            input_handle.process_path(),
            *("-map", "0:v:0", "-c:v", "copy"),
            *("-bsf:v", "trace_headers", "-frames:v", "1"),
            *("-f", "null", "-"),
        ]
        try:
            process = subprocess.Popen(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                env=self.environment,
                pass_fds=(input_handle.fileno(),),
            )
            return_code, raw_trace = self._capture_output(process)
        except (FileNotFoundError, OSError) as error:
            raise MediaProcessError("trace") from error
        if return_code != 0:
            raise MediaIssue("unsupported_video")
        return parse_sps_trace(raw_trace)

    def _run_probe(
        self,
        input_handle: InputHandle,
        entries: str,
        read_frame: bool,
    ) -> JsonValue:
        input_handle.rewind()
        arguments = [
            self.ffprobe_binary,
            *("-v", "error", "-protocol_whitelist", "file"),
            *("-f", "mov", "-select_streams", "v:0"),
            *("-apply_cropping", "0"),
        ]
        if read_frame:
            arguments += ["-read_intervals", "%+#1"]
        arguments += [
            *("-show_optional_fields", "always", "-show_entries"),
            entries,
            *("-of", "json"),
            input_handle.process_path(),
        ]
        try:
            process = subprocess.Popen(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=self.environment,
                pass_fds=(input_handle.fileno(),),
            )
            return_code, raw_probe = self._capture_output(process)
        except (FileNotFoundError, OSError) as error:
            raise MediaProcessError("probe") from error
        if return_code != 0:
            raise MediaIssue("decode_failed")
        try:
            payload: JsonValue = json.loads(raw_probe)
        except json.JSONDecodeError as error:
            raise MediaIssue("unsupported_video") from error
        return payload

    def _capture_output(self, process: subprocess.Popen[bytes]) -> tuple[int, bytes]:
        stream = process.stdout or process.stderr
        if stream is None:
            self.stop(process)
            raise MediaProcessError("pipes")
        deadline = time.monotonic() + self.deadline_seconds
        with io.BytesIO() as output:
            selector = selectors.DefaultSelector()
            try:
                selector.register(stream, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise MediaIssue("analysis_failed")
                    if not selector.select(min(remaining, 0.25)):
                        continue
                    chunk = os.read(
                        stream.fileno(),
                        min(
                            CAPTURE_CHUNK_BYTES,
                            TRACE_LIMIT_BYTES + 1 - output.tell(),
                        ),
                    )
                    if not chunk:
                        break
                    output.write(chunk)
                    if output.tell() > TRACE_LIMIT_BYTES:
                        raise MediaIssue("unsupported_video")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise MediaIssue("analysis_failed")
                return_code = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired as error:
                raise MediaIssue("analysis_failed") from error
            finally:
                selector.close()
                if process.poll() is None:
                    self.stop(process)
                stream.close()
            return return_code, output.getvalue()

    def stream_frames(self, input_handle: InputHandle) -> Iterable[GrayFrame]:
        if not probe_is_supported(self.probe(input_handle)):
            raise MediaIssue("unsupported_video")
        yield from self._decode(input_handle)

    def _decode(self, input_handle: InputHandle) -> Iterable[GrayFrame]:
        input_handle.rewind()
        arguments = [
            self.ffmpeg_binary,
            *("-hide_banner", "-loglevel", "error", "-nostdin"),
            *("-protocol_whitelist", "file", "-f", "mov", "-i"),
            input_handle.process_path(),
            *("-map", "0:v:0", "-vf"),
            "fps=8,scale=160:104:flags=area,format=gray",
            *("-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"),
        ]
        try:
            process = subprocess.Popen(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=self.environment,
                pass_fds=(input_handle.fileno(),),
            )
        except (FileNotFoundError, OSError) as error:
            raise MediaProcessError("decode") from error
        yield from self.read_process(process)

    def read_process(self, process: subprocess.Popen[bytes]) -> Generator[GrayFrame]:
        if process.stdout is None or process.stderr is None:
            self.stop(process)
            raise MediaProcessError("pipes")
        frame = bytearray()
        frame_index = 0
        deadline = time.monotonic() + self.deadline_seconds
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        try:
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.stop(process)
                    raise MediaIssue("analysis_failed")
                for key, _ in selector.select(min(remaining, 0.25)):
                    size = FRAME_BYTES - len(frame) if key.data == "stdout" else 65_536
                    chunk = os.read(key.fd, size)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    elif key.data == "stdout":
                        frame.extend(chunk)
                        if len(frame) == FRAME_BYTES:
                            yield GrayFrame(frame_index * 125, bytes(frame))
                            frame.clear()
                            frame_index += 1
            return_code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        except (OSError, subprocess.TimeoutExpired) as error:
            self.stop(process)
            raise MediaProcessError("stream") from error
        finally:
            selector.close()
            if process.poll() is None:
                self.stop(process)
            process.stdout.close()
            process.stderr.close()
        if return_code != 0 or frame:
            raise MediaIssue("decode_failed")

    @staticmethod
    def stop(process: subprocess.Popen[bytes]) -> None:
        try:
            process.terminate()
        except ProcessLookupError:
            process.wait()
            return
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
