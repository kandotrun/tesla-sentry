from __future__ import annotations

import os
import stat
import sys
from collections.abc import Generator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Final

DIRECTORY_FLAGS: Final = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
FILE_FLAGS: Final = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
WRITE_FLAGS: Final = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
TEMPORARY_NAME: Final = "result.tmp.json"
FINAL_NAME: Final = "result.json"


@dataclass(frozen=True, slots=True)
class FileIdentity:
    device: int
    inode: int
    size: int
    modified_ns: int
    changed_ns: int

    @classmethod
    def from_stat(cls, metadata: os.stat_result) -> FileIdentity:
        return cls(
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_size,
            metadata.st_mtime_ns,
            metadata.st_ctime_ns,
        )

    def object_key(self) -> tuple[int, int]:
        return (self.device, self.inode)


@dataclass(frozen=True, slots=True)
class InputHandle:
    descriptor: int
    parent_descriptor: int
    leaf_name: str
    identity: FileIdentity

    def fileno(self) -> int:
        return self.descriptor

    def process_path(self) -> str:
        if sys.platform == "darwin":
            return f"/dev/fd/{self.descriptor}"
        return f"/proc/self/fd/{self.descriptor}"

    def rewind(self) -> None:
        os.lseek(self.descriptor, 0, os.SEEK_SET)

    def verify_unchanged(self) -> None:
        descriptor_identity = FileIdentity.from_stat(os.fstat(self.descriptor))
        path_identity = FileIdentity.from_stat(
            os.stat(self.leaf_name, dir_fd=self.parent_descriptor, follow_symlinks=False)
        )
        if descriptor_identity != self.identity or path_identity != self.identity:
            raise OSError("input changed during analysis")


@dataclass(frozen=True, slots=True)
class OutputHandle:
    parent_descriptor: int
    directory_descriptor: int
    leaf_name: str
    identity: FileIdentity

    def verify_attached(self) -> None:
        directory_identity = FileIdentity.from_stat(os.fstat(self.directory_descriptor))
        path_identity = FileIdentity.from_stat(
            os.stat(self.leaf_name, dir_fd=self.parent_descriptor, follow_symlinks=False)
        )
        expected = self.identity.object_key()
        if directory_identity.object_key() != expected or path_identity.object_key() != expected:
            raise OSError("output changed during analysis")

    def write(self, payload: bytes) -> None:
        self.verify_attached()
        if _entry_exists(self.directory_descriptor, TEMPORARY_NAME):
            raise FileExistsError("temporary result exists")
        if _entry_exists(self.directory_descriptor, FINAL_NAME):
            raise FileExistsError("final result exists")
        descriptor = os.open(
            TEMPORARY_NAME,
            WRITE_FLAGS,
            0o600,
            dir_fd=self.directory_descriptor,
        )
        try:
            _write_all(descriptor, payload)
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            self.verify_attached()
            os.link(
                TEMPORARY_NAME,
                FINAL_NAME,
                src_dir_fd=self.directory_descriptor,
                dst_dir_fd=self.directory_descriptor,
                follow_symlinks=False,
            )
            os.unlink(TEMPORARY_NAME, dir_fd=self.directory_descriptor)
            os.fsync(self.directory_descriptor)
        except (OSError, TypeError, ValueError):
            if descriptor >= 0:
                os.close(descriptor)
            with suppress(FileNotFoundError):
                os.unlink(TEMPORARY_NAME, dir_fd=self.directory_descriptor)
            raise


def _entry_exists(directory_descriptor: int, name: str) -> bool:
    try:
        os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        return False
    return True


def _write_all(descriptor: int, payload: bytes) -> None:
    position = 0
    while position < len(payload):
        position += os.write(descriptor, payload[position:])


@contextmanager
def open_input(input_root: Path, relative_path: str) -> Generator[InputHandle]:
    root_descriptor = os.open(input_root, DIRECTORY_FLAGS)
    parent_descriptor = root_descriptor
    opened_directories: list[int] = []
    descriptor = -1
    try:
        segments = PurePosixPath(relative_path).parts
        for segment in segments[:-1]:
            child = os.open(segment, DIRECTORY_FLAGS, dir_fd=parent_descriptor)
            opened_directories.append(child)
            parent_descriptor = child
        leaf_name = segments[-1]
        descriptor = os.open(leaf_name, FILE_FLAGS, dir_fd=parent_descriptor)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError("input is not a regular file")
        identity = FileIdentity.from_stat(metadata)
        handle = InputHandle(descriptor, parent_descriptor, leaf_name, identity)
        handle.verify_unchanged()
        yield handle
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        for opened in reversed(opened_directories):
            os.close(opened)
        os.close(root_descriptor)


@contextmanager
def open_output(output_root: Path) -> Generator[OutputHandle]:
    parent_path = output_root.parent
    leaf_name = output_root.name
    if not leaf_name:
        raise OSError("output root needs a leaf name")
    parent_descriptor = os.open(parent_path, DIRECTORY_FLAGS)
    directory_descriptor = -1
    try:
        try:
            metadata = os.stat(leaf_name, dir_fd=parent_descriptor, follow_symlinks=False)
        except FileNotFoundError:
            os.mkdir(leaf_name, mode=0o700, dir_fd=parent_descriptor)
            metadata = os.stat(leaf_name, dir_fd=parent_descriptor, follow_symlinks=False)
        if not stat.S_ISDIR(metadata.st_mode):
            raise OSError("output root is not a directory")
        directory_descriptor = os.open(leaf_name, DIRECTORY_FLAGS, dir_fd=parent_descriptor)
        if os.listdir(directory_descriptor):
            raise OSError("output root is not empty")
        identity = FileIdentity.from_stat(os.fstat(directory_descriptor))
        handle = OutputHandle(parent_descriptor, directory_descriptor, leaf_name, identity)
        handle.verify_attached()
        yield handle
    finally:
        if directory_descriptor >= 0:
            os.close(directory_descriptor)
        os.close(parent_descriptor)
