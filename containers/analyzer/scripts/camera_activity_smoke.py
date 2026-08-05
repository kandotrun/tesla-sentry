from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from container_smoke import make_camera_activity_fixtures


def main() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    with tempfile.TemporaryDirectory(prefix="tesla-camera-activity-smoke-") as directory:
        root = Path(directory)
        input_root = root / "input"
        input_root.mkdir()
        make_camera_activity_fixtures(input_root)
        cameras = (
            "front",
            "back",
            "left_repeater",
            "right_repeater",
            "left_pillar",
            "right_pillar",
        )
        request_path = root / "request.json"
        request_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "eventId": "host-fixture-event",
                    "cameras": [
                        {
                            "camera": camera,
                            "clipId": f"{camera}-fixture",
                            "relativePath": f"camera-event/{camera}.mp4",
                        }
                        for camera in cameras
                    ],
                }
            )
        )
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(repository_root / "containers/analyzer/src")
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "sentry_analyzer.camera_activity_cli",
                "--request",
                str(request_path),
                "--input-root",
                str(input_root),
                "--output-root",
                str(root / "output"),
            ],
            cwd=repository_root,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=180,
        )
        if completed.returncode != 0 or completed.stderr:
            raise RuntimeError("camera activity host smoke failed")
        result = json.loads((root / "output/result.json").read_text())
        if result["status"] != "activity_detected" or len(result["cameras"]) != 6:
            raise RuntimeError("camera activity host smoke result is invalid")
        if [item["status"] for item in result["cameras"]].count("activity_detected") != 1:
            raise RuntimeError("camera activity host smoke result is invalid")
        print(completed.stdout, end="")


if __name__ == "__main__":
    main()
