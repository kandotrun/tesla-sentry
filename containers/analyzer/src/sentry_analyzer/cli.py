"""Command-line boundary for one-event preprocessing."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from .preprocess import ContractError, FFmpegMediaTool, parse_request, preprocess_event

MAX_REQUEST_BYTES = 1024 * 1024
EXIT_BY_STATUS = {"ready": 0, "partial": 3, "failed": 4}


def _error(code: str, message: str) -> None:
    print(json.dumps({"error": {"code": code, "message": message}}), file=sys.stderr)


def _read_request(path: Path) -> object:
    try:
        with path.open("rb") as request_file:
            raw_request = request_file.read(MAX_REQUEST_BYTES + 1)
        if not raw_request or len(raw_request) > MAX_REQUEST_BYTES:
            raise ContractError("request file must be between 1 byte and 1 MiB")
        return json.loads(raw_request.decode("utf-8"))
    except UnicodeDecodeError as error:
        raise ContractError("request file must be UTF-8 JSON") from error
    except json.JSONDecodeError as error:
        raise ContractError("request file must contain valid JSON") from error
    except OSError as error:
        raise ContractError("request file is unavailable") from error


def write_result(output_root: Path, payload: dict[str, object]) -> None:
    output_root.mkdir(parents=True, exist_ok=True)
    temporary_path = output_root / "result.tmp.json"
    final_path = output_root / "result.json"
    temporary_path.unlink(missing_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temporary_path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise
    temporary_path.replace(final_path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Preprocess one TeslaCam event with FFmpeg.")
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        request = parse_request(_read_request(arguments.request))
        result = preprocess_event(
            request,
            arguments.input_root,
            arguments.output_root,
            FFmpegMediaTool(),
        )
        write_result(arguments.output_root, result.to_dict())
    except ContractError:
        _error("invalid_request", "The preprocessing request is invalid.")
        return 2
    except OSError:
        _error("io_error", "The preprocessing result could not be stored.")
        return 5
    # This is the process boundary: never leak request paths or FFmpeg details in a traceback.
    except Exception:  # noqa: BLE001
        _error("internal_error", "The preprocessing command failed unexpectedly.")
        return 5

    print(
        json.dumps(
            {
                "status": result.status,
                "processedClips": len(result.clips),
                "issues": len(result.issues),
            }
        )
    )
    return EXIT_BY_STATUS[result.status]
