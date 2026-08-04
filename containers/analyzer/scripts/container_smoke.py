"""Build and execute the analyzer image against the committed MP4 fixture."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import cast

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

        print(
            json.dumps(
                {
                    "status": result["status"],
                    "processedClips": result["processedClips"],
                    "issues": result["issues"],
                }
            )
        )
    finally:
        if output_root.is_dir():
            _remove_container_owned_outputs(repository_root, output_root)
        shutil.rmtree(root)


if __name__ == "__main__":
    main()
