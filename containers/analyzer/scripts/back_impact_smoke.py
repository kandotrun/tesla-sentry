from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Final, TypeAlias

JsonValue: TypeAlias = bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"] | None
WIDTH: Final = 160
HEIGHT: Final = 104


def _pixels(shift: int) -> bytes:
    values = bytearray(WIDTH * HEIGHT)
    for y in range(HEIGHT):
        for x in range(WIDTH):
            values[y * WIDTH + x] = (((x - shift) // 8 + y // 8) % 2) * 120 + 60
    return bytes(values)


def _make_video(root: Path, impact: bool) -> Path:
    frames = root / "frames"
    frames.mkdir()
    for index in range(32):
        shift = 3 if impact and index in {12, 13} else 0
        (frames / f"{index:03d}.pgm").write_bytes(b"P5\n160 104\n255\n" + _pixels(shift))
    output = root / "back.mp4"
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
            "-movflags",
            "+faststart",
            str(output),
        ],
        check=True,
    )
    return output


def _analyze(root: Path, impact: bool) -> str:
    root.mkdir()
    input_root = root / "input"
    input_root.mkdir()
    source_path = _make_video(input_root, impact)
    source_snapshot = (source_path.stat().st_size, source_path.stat().st_mtime_ns)
    request_path = root / "request.json"
    request_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "clipId": "back-smoke",
                "camera": "back",
                "relativePath": "back.mp4",
            }
        ),
        encoding="utf-8",
    )
    output_root = root / "output"
    environment = {"LANG": "C", "LC_ALL": "C", "PATH": os.environ.get("PATH", os.defpath)}
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "sentry_analyzer.back_impact_cli",
            "--request",
            str(request_path),
            "--input-root",
            str(input_root),
            "--output-root",
            str(output_root),
        ],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0 or completed.stderr:
        raise RuntimeError("back impact smoke command failed")
    result_text = (output_root / "result.json").read_text(encoding="utf-8")
    if (output_root / "result.json").stat().st_mode & 0o777 != 0o600:
        raise RuntimeError("back impact smoke result mode is invalid")
    result: JsonValue = json.loads(result_text)
    if not isinstance(result, dict):
        raise RuntimeError("back impact smoke result is invalid")
    status = result.get("status")
    if not isinstance(status, str):
        raise RuntimeError("back impact smoke status is invalid")
    if str(root) in result_text or "back.mp4" in result_text:
        raise RuntimeError("back impact smoke result disclosed source details")
    expected_summary = {"status": status, "analyzedFrames": 32, "issues": 0}
    if json.loads(completed.stdout) != expected_summary:
        raise RuntimeError("back impact smoke summary is invalid")
    if (source_path.stat().st_size, source_path.stat().st_mtime_ns) != source_snapshot:
        raise RuntimeError("back impact smoke source changed")
    return status


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="tesla-back-impact-smoke-") as directory:
        root = Path(directory)
        no_impact = _analyze(root / "static", False)
        impact = _analyze(root / "impact", True)
    expected = ("no_impact_signal_observed", "possible_contact")
    if (no_impact, impact) != expected:
        raise RuntimeError("back impact smoke verdicts are unexpected")
    print(json.dumps({"noImpact": no_impact, "impact": impact}, separators=(",", ":")))


if __name__ == "__main__":
    main()
