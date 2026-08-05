"""Build and execute the analyzer image against the committed MP4 fixture."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import TypeAlias, TypedDict, cast

IMAGE_TAG = "tesla-sentry-analyzer:ci-smoke"
OUTPUT_VALIDATION_CODE = """
import json
import stat
from pathlib import Path

output_root = Path('/output')
result_path = output_root / 'result.json'
assert stat.S_IMODE(result_path.stat().st_mode) == 0o600
result = json.loads(result_path.read_text(encoding='utf-8'))
assert result['status'] == 'ready'
assert len(result['clips']) == 1
assert result['issues'] == []
frame_path = (output_root / result['clips'][0]['frame']['relativePath']).resolve()
frame_path.relative_to(output_root.resolve())
assert frame_path.read_bytes()[:2] == b'\\xff\\xd8'
assert stat.S_IMODE(frame_path.stat().st_mode) == 0o600
print(json.dumps({'status': 'ready', 'processedClips': 1, 'issues': 0}))
"""
BACK_OUTPUT_VALIDATION_CODE = """
import json
import stat
from pathlib import Path

result_path = Path('/output/result.json')
assert stat.S_IMODE(result_path.stat().st_mode) == 0o600
result = json.loads(result_path.read_text(encoding='utf-8'))
assert result['status'] == 'possible_contact'
assert result['analyzedFrames'] == 32
assert result['issues'] == []
serialized = json.dumps(result)
assert '/input' not in serialized
assert 'back.mp4' not in serialized
print(json.dumps({'status': result['status'], 'analyzedFrames': 32, 'issues': 0}))
"""
CAMERA_OUTPUT_VALIDATION_CODE = """
import json
import stat
from pathlib import Path

result_path = Path('/output/result.json')
assert stat.S_IMODE(result_path.stat().st_mode) == 0o600
result = json.loads(result_path.read_text(encoding='utf-8'))
assert result['status'] == 'activity_detected'
assert len(result['cameras']) == 6
assert [item['camera'] for item in result['cameras']] == [
    'front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'
]
assert [item['status'] for item in result['cameras']].count('activity_detected') == 1
serialized = json.dumps(result)
assert '/input' not in serialized
assert '.mp4' not in serialized
print(json.dumps({'status': result['status'], 'cameras': 6, 'activity': 1, 'indeterminate': 0}))
"""


class BackSummary(TypedDict):
    status: str
    analyzedFrames: int
    issues: int


class CameraSummary(TypedDict):
    status: str
    cameras: int
    activity: int
    indeterminate: int


JsonValue: TypeAlias = bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"] | None


def parse_back_summary(payload: JsonValue) -> BackSummary:
    if not isinstance(payload, dict):
        raise RuntimeError("back impact container returned an invalid summary")
    if frozenset(payload) != frozenset({"status", "analyzedFrames", "issues"}):
        raise RuntimeError("back impact container returned an invalid summary")
    status = payload["status"]
    analyzed_frames = payload["analyzedFrames"]
    issues = payload["issues"]
    if not isinstance(status, str) or status != "possible_contact":
        raise RuntimeError("back impact container returned an invalid summary")
    if isinstance(analyzed_frames, bool) or not isinstance(analyzed_frames, int):
        raise RuntimeError("back impact container returned an invalid summary")
    if analyzed_frames != 32:
        raise RuntimeError("back impact container returned an invalid summary")
    if isinstance(issues, bool) or not isinstance(issues, int):
        raise RuntimeError("back impact container returned an invalid summary")
    if issues != 0:
        raise RuntimeError("back impact container returned an invalid summary")
    return {"status": status, "analyzedFrames": analyzed_frames, "issues": issues}


def _make_back_fixture(root: Path) -> None:
    frames = root / "back-frames"
    frames.mkdir()
    for index in range(32):
        shift = 3 if index in {12, 13} else 0
        pixels = bytearray(160 * 104)
        for y in range(104):
            for x in range(160):
                pixels[y * 160 + x] = (((x - shift) // 8 + y // 8) % 2) * 120 + 60
        (frames / f"{index:03d}.pgm").write_bytes(b"P5\n160 104\n255\n" + pixels)
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-framerate",
            "8",
            "-i",
            str(frames / "%03d.pgm"),
            "-vf",
            "scale=1448:938:flags=neighbor,format=yuv420p",
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            str(root / "back.mp4"),
        ],
        check=True,
    )


def _write_activity_frames(root: Path, changing: bool) -> Path:
    frames = root / ("camera-changing-frames" if changing else "camera-static-frames")
    frames.mkdir()
    for index in range(32):
        variant = 1 if changing and index == 12 else 2 if changing and index == 13 else 0
        pixels = bytes(
            (x * (17 + variant * 13) + y * (31 + variant * 7) + variant * 97) % 256
            for y in range(104)
            for x in range(160)
        )
        (frames / f"{index:03d}.pgm").write_bytes(b"P5\n160 104\n255\n" + pixels)
    return frames


def _encode_activity_fixture(frames: Path, output: Path, scale: str) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-framerate",
            "8",
            "-i",
            str(frames / "%03d.pgm"),
            "-vf",
            f"scale={scale}:flags=neighbor,format=yuv420p",
            "-c:v",
            "libx264",
            "-profile:v",
            "high",
            str(output),
        ],
        check=True,
    )


def make_camera_activity_fixtures(root: Path) -> Path:
    event_root = root / "camera-event"
    event_root.mkdir()
    static_frames = _write_activity_frames(root, False)
    changing_frames = _write_activity_frames(root, True)
    _encode_activity_fixture(static_frames, event_root / "front.mp4", "2896:1876")
    _encode_activity_fixture(changing_frames, event_root / "back.mp4", "1448:938")
    _encode_activity_fixture(
        static_frames,
        event_root / "left_repeater.mp4",
        "1448:938",
    )
    for camera in ("right_repeater", "left_pillar", "right_pillar"):
        shutil.copyfile(event_root / "left_repeater.mp4", event_root / f"{camera}.mp4")
    return event_root


def _remove_container_owned_outputs(repository_root: Path, output_root: Path) -> None:
    subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--mount",
            f"type=bind,src={output_root},dst=/output",
            "--entrypoint",
            "/bin/rm",
            IMAGE_TAG,
            "-rf",
            "/output/frames",
            "/output/result.json",
            "/output/result.tmp.json",
        ],
        cwd=repository_root,
        check=False,
        capture_output=True,
        timeout=30,
    )


def _validate_container_outputs(repository_root: Path, output_root: Path) -> dict[str, object]:
    completed = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--memory",
            "128m",
            "--pids-limit",
            "64",
            "--mount",
            f"type=bind,src={output_root},dst=/output,readonly",
            "--entrypoint",
            "python",
            IMAGE_TAG,
            "-c",
            OUTPUT_VALIDATION_CODE,
        ],
        cwd=repository_root,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError("analyzer container output validation failed")
    summary = cast(object, json.loads(completed.stdout))
    if not isinstance(summary, dict):
        raise RuntimeError("analyzer container returned an invalid validation summary")
    return cast(dict[str, object], summary)


def _validate_back_outputs(repository_root: Path, output_root: Path) -> BackSummary:
    completed = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--mount",
            f"type=bind,src={output_root},dst=/output,readonly",
            "--entrypoint",
            "python",
            IMAGE_TAG,
            "-c",
            BACK_OUTPUT_VALIDATION_CODE,
        ],
        cwd=repository_root,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError("back impact container output validation failed")
    payload: JsonValue = json.loads(completed.stdout)
    return parse_back_summary(payload)


def _validate_camera_outputs(repository_root: Path, output_root: Path) -> CameraSummary:
    completed = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--mount",
            f"type=bind,src={output_root},dst=/output,readonly",
            "--entrypoint",
            "python",
            IMAGE_TAG,
            "-c",
            CAMERA_OUTPUT_VALIDATION_CODE,
        ],
        cwd=repository_root,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError("camera activity container output validation failed")
    payload: JsonValue = json.loads(completed.stdout)
    if not isinstance(payload, dict):
        raise RuntimeError("camera activity container returned an invalid summary")
    expected: CameraSummary = {
        "status": "activity_detected",
        "cameras": 6,
        "activity": 1,
        "indeterminate": 0,
    }
    if payload != expected:
        raise RuntimeError("camera activity container returned an invalid summary")
    return expected


def main() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    analyzer_root = repository_root / "containers/analyzer"
    fixture = repository_root / "packages/video-preflight/tests/fixtures/one-second-avc.mp4"

    subprocess.run(
        ["docker", "build", "--pull", "--quiet", "--tag", IMAGE_TAG, str(analyzer_root)],
        cwd=repository_root,
        check=True,
    )

    root = Path(tempfile.mkdtemp(prefix="tesla-analyzer-container-smoke-"))
    output_root = root / "output"
    try:
        input_root = root / "input"
        input_root.mkdir()
        output_root.mkdir()
        # The mkdtemp parent is 0700. The mounted directory itself must be listable and
        # writable by the image's UID 10001.
        output_root.chmod(0o777)
        shutil.copyfile(fixture, input_root / "front.mp4")

        request_path = root / "request.json"
        request_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "eventId": "container-fixture-event",
                    "clips": [
                        {
                            "clipId": "front-fixture",
                            "camera": "front",
                            "capturedAt": "2030-01-01T12:00:00",
                            "relativePath": "front.mp4",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,size=64m",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--memory",
                "1g",
                "--cpus",
                "2",
                "--pids-limit",
                "128",
                "--mount",
                f"type=bind,src={request_path},dst=/request.json,readonly",
                "--mount",
                f"type=bind,src={input_root},dst=/input,readonly",
                "--mount",
                f"type=bind,src={output_root},dst=/output",
                IMAGE_TAG,
                "--request",
                "/request.json",
                "--input-root",
                "/input",
                "--output-root",
                "/output",
            ],
            cwd=repository_root,
            text=True,
            capture_output=True,
            check=False,
            timeout=120,
        )
        if completed.returncode != 0:
            raise RuntimeError("analyzer container smoke command failed")

        result = _validate_container_outputs(repository_root, output_root)
        if result != {"status": "ready", "processedClips": 1, "issues": 0}:
            raise RuntimeError("analyzer container returned an unexpected result")

        _remove_container_owned_outputs(repository_root, output_root)
        _make_back_fixture(input_root)
        back_request_path = root / "back-request.json"
        back_request_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "clipId": "back-container-fixture",
                    "camera": "back",
                    "relativePath": "back.mp4",
                }
            ),
            encoding="utf-8",
        )
        back_completed = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,size=64m",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--memory",
                "1g",
                "--cpus",
                "2",
                "--pids-limit",
                "128",
                "--mount",
                f"type=bind,src={back_request_path},dst=/request.json,readonly",
                "--mount",
                f"type=bind,src={input_root},dst=/input,readonly",
                "--mount",
                f"type=bind,src={output_root},dst=/output",
                "--entrypoint",
                "python",
                IMAGE_TAG,
                "-m",
                "sentry_analyzer.back_impact_cli",
                "--request",
                "/request.json",
                "--input-root",
                "/input",
                "--output-root",
                "/output",
            ],
            cwd=repository_root,
            text=True,
            capture_output=True,
            check=False,
            timeout=120,
        )
        if back_completed.returncode != 0 or back_completed.stderr:
            raise RuntimeError("back impact container smoke command failed")
        back_result = _validate_back_outputs(repository_root, output_root)
        expected_back: BackSummary = {
            "status": "possible_contact",
            "analyzedFrames": 32,
            "issues": 0,
        }
        if back_result != expected_back:
            raise RuntimeError("back impact container returned an unexpected result")
        if str(root) in back_completed.stdout or "back.mp4" in back_completed.stdout:
            raise RuntimeError("back impact container disclosed source details")

        _remove_container_owned_outputs(repository_root, output_root)
        event_root = make_camera_activity_fixtures(input_root)
        camera_request_path = root / "camera-request.json"
        camera_request_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "eventId": "camera-container-fixture",
                    "cameras": [
                        {
                            "camera": camera,
                            "clipId": f"{camera}-fixture",
                            "relativePath": f"camera-event/{camera}.mp4",
                        }
                        for camera in (
                            "front",
                            "back",
                            "left_repeater",
                            "right_repeater",
                            "left_pillar",
                            "right_pillar",
                        )
                    ],
                }
            ),
            encoding="utf-8",
        )
        camera_completed = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,size=64m",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--memory",
                "1g",
                "--cpus",
                "2",
                "--pids-limit",
                "128",
                "--mount",
                f"type=bind,src={camera_request_path},dst=/request.json,readonly",
                "--mount",
                f"type=bind,src={input_root},dst=/input,readonly",
                "--mount",
                f"type=bind,src={output_root},dst=/output",
                "--entrypoint",
                "python",
                IMAGE_TAG,
                "-m",
                "sentry_analyzer.camera_activity_cli",
                "--request",
                "/request.json",
                "--input-root",
                "/input",
                "--output-root",
                "/output",
            ],
            cwd=repository_root,
            text=True,
            capture_output=True,
            check=False,
            timeout=180,
        )
        if camera_completed.returncode != 0 or camera_completed.stderr:
            raise RuntimeError("camera activity container smoke command failed")
        camera_result = _validate_camera_outputs(repository_root, output_root)
        if str(root) in camera_completed.stdout or str(event_root) in camera_completed.stdout:
            raise RuntimeError("camera activity container disclosed source details")

        print(
            json.dumps(
                {
                    "status": result["status"],
                    "processedClips": result["processedClips"],
                    "issues": result["issues"],
                    "backImpact": back_result["status"],
                    "cameraActivity": camera_result["status"],
                }
            )
        )
    finally:
        if output_root.is_dir():
            _remove_container_owned_outputs(repository_root, output_root)
        shutil.rmtree(root)


if __name__ == "__main__":
    main()
