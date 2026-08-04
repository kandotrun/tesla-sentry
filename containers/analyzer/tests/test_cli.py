from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from sentry_analyzer.cli import write_result


class AnalyzerCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repository_root = Path(__file__).resolve().parents[3]
        self.fixture = (
            self.repository_root / "packages/video-preflight/tests/fixtures/one-second-avc.mp4"
        )

    def run_cli(
        self, request: object, input_files: dict[str, Path]
    ) -> tuple[subprocess.CompletedProcess[str], Path]:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        root = Path(temporary_directory.name)
        input_root = root / "input"
        output_root = root / "output"
        input_root.mkdir()
        for relative_path, source in input_files.items():
            destination = input_root / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        request_path = root / "request.json"
        request_path.write_text(json.dumps(request), encoding="utf-8")
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(self.repository_root / "containers/analyzer/src")
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "sentry_analyzer",
                "--request",
                str(request_path),
                "--input-root",
                str(input_root),
                "--output-root",
                str(output_root),
            ],
            cwd=self.repository_root,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )
        return completed, output_root

    @staticmethod
    def request(*clips: dict[str, str]) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "eventId": "fixture-event",
            "clips": list(clips),
        }

    @staticmethod
    def clip(clip_id: str, relative_path: str) -> dict[str, str]:
        return {
            "clipId": clip_id,
            "camera": "front",
            "capturedAt": "2030-01-01T12:00:00",
            "relativePath": relative_path,
        }

    def test_ready_event_writes_atomic_result_json_and_returns_zero(self) -> None:
        completed, output_root = self.run_cli(
            self.request(self.clip("front-001", "front.mp4")),
            {"front.mp4": self.fixture},
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads((output_root / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["clips"][0]["probe"]["codecName"], "h264")
        self.assertFalse((output_root / "result.tmp.json").exists())
        summary = json.loads(completed.stdout)
        self.assertNotIn("eventId", summary)
        self.assertNotIn(str(self.fixture), completed.stdout + completed.stderr)

    def test_partial_event_is_preserved_and_returns_three(self) -> None:
        completed, output_root = self.run_cli(
            self.request(
                self.clip("front-001", "front.mp4"),
                self.clip("front-missing", "missing.mp4"),
            ),
            {"front.mp4": self.fixture},
        )

        self.assertEqual(completed.returncode, 3, completed.stderr)
        result = json.loads((output_root / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "partial")
        self.assertEqual(
            result["issues"],
            [
                {
                    "clipId": "front-missing",
                    "code": "input_missing",
                    "message": "The input clip is unavailable.",
                }
            ],
        )

    def test_failed_event_is_preserved_and_returns_four(self) -> None:
        completed, output_root = self.run_cli(
            self.request(self.clip("front-missing", "missing.mp4")),
            {},
        )

        self.assertEqual(completed.returncode, 4, completed.stderr)
        result = json.loads((output_root / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["clips"], [])

    def test_contract_error_returns_two_without_creating_output(self) -> None:
        completed, output_root = self.run_cli(
            self.request(self.clip("front-001", "../private.mp4")),
            {},
        )

        self.assertEqual(completed.returncode, 2)
        self.assertFalse(output_root.exists())
        error = json.loads(completed.stderr)
        self.assertEqual(error["error"]["code"], "invalid_request")
        self.assertNotIn("private.mp4", completed.stderr)

    def test_rejects_a_request_larger_than_one_mibibyte(self) -> None:
        completed, output_root = self.run_cli(
            {
                "schemaVersion": 1,
                "eventId": "e" * (1024 * 1024),
                "clips": [self.clip("front-001", "front.mp4")],
            },
            {},
        )

        self.assertEqual(completed.returncode, 2)
        self.assertFalse(output_root.exists())
        self.assertEqual(json.loads(completed.stderr)["error"]["code"], "invalid_request")

    def test_atomic_result_write_does_not_follow_an_existing_temporary_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            output_root = root / "output"
            output_root.mkdir()
            outside = root / "outside.json"
            outside.write_text("do-not-overwrite", encoding="utf-8")
            (output_root / "result.tmp.json").symlink_to(outside)

            write_result(output_root, {"status": "ready"})

            self.assertEqual(outside.read_text(encoding="utf-8"), "do-not-overwrite")
            self.assertEqual(
                json.loads((output_root / "result.json").read_text(encoding="utf-8")),
                {"status": "ready"},
            )


if __name__ == "__main__":
    unittest.main()
