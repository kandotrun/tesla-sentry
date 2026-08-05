import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXPECTED_EXECUTABLE_RESOLUTION_ERROR_CODES = new Set([
  "EACCES",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

const SUFFIXES = [
  ["right_repeater", "right_repeater"],
  ["left_repeater", "left_repeater"],
  ["right_pillar", "right_pillar"],
  ["left_pillar", "left_pillar"],
  ["rear_view", "back"],
  ["front", "front"],
  ["back", "back"],
];

export function parseRecognizedFilename(filePath) {
  const name = filePath.slice(dirname(filePath).length + 1);
  const lowerName = name.toLowerCase();
  for (const [suffix, camera] of SUFFIXES) {
    const ending = `-${suffix}.mp4`;
    if (lowerName.endsWith(ending) && name.length > ending.length) {
      return {
        camera,
        groupKey: `${dirname(filePath)}\u0000${lowerName.slice(0, -ending.length)}`,
      };
    }
  }
  return null;
}

export async function discoverMp4Inventory(sourceDir) {
  const rootMetadata = await lstat(sourceDir);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("source_directory_invalid");
  }
  const files = [];
  const directories = [sourceDir];
  const directoryIdentities = [];
  while (directories.length > 0) {
    const directory = directories.pop();
    const directoryMetadata = await lstat(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error("source_inventory_failed");
    }
    directoryIdentities.push({
      device: directoryMetadata.dev,
      inode: directoryMetadata.ino,
      relativePath: relative(sourceDir, directory).split(sep).join("/"),
    });
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(target);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) {
        const metadata = await lstat(target);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error("source_inventory_failed");
        }
        files.push({
          device: metadata.dev,
          filePath: target,
          inode: metadata.ino,
          mode: metadata.mode,
          mtimeMs: metadata.mtimeMs,
          relativePath: relative(sourceDir, target).split(sep).join("/"),
          size: metadata.size,
        });
      }
    }
  }
  files.sort((left, right) => left.filePath.localeCompare(right.filePath));
  directoryIdentities.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    directories: directoryIdentities,
    files,
    root: { device: rootMetadata.dev, inode: rootMetadata.ino },
  };
}

export async function discoverMp4Files(sourceDir) {
  return (await discoverMp4Inventory(sourceDir)).files;
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function isExpectedExecutableResolutionError(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    EXPECTED_EXECUTABLE_RESOLUTION_ERROR_CODES.has(error.code)
  );
}

export async function resolveInventoryAnalyzerProcess({
  environment,
  executableName,
  pythonPath,
  sourceDir,
}) {
  const sourceRoot = await realpath(sourceDir);
  const directories = [];
  for (const rawDirectory of (environment.PATH ?? "").split(delimiter)) {
    if (!rawDirectory || !isAbsolute(rawDirectory)) {
      continue;
    }
    try {
      const directory = await realpath(rawDirectory);
      const metadata = await lstat(directory);
      if (
        !metadata.isDirectory() ||
        isWithin(sourceRoot, directory) ||
        directories.includes(directory)
      ) {
        continue;
      }
      directories.push(directory);
    } catch (error) {
      if (!isExpectedExecutableResolutionError(error)) {
        throw error;
      }
    }
  }
  for (const directory of directories) {
    try {
      const executable = await realpath(join(directory, executableName));
      const metadata = await lstat(executable);
      await access(executable, constants.X_OK);
      if (!metadata.isFile() || isWithin(sourceRoot, executable)) {
        continue;
      }
      return {
        environment: {
          LANG: typeof environment.LANG === "string" && environment.LANG ? environment.LANG : "C",
          LC_ALL:
            typeof environment.LC_ALL === "string" && environment.LC_ALL ? environment.LC_ALL : "C",
          PATH: directories.join(delimiter),
          PYTHONPATH: pythonPath,
        },
        executable,
      };
    } catch (error) {
      if (!isExpectedExecutableResolutionError(error)) {
        throw error;
      }
    }
  }
  throw new Error("analysis_failed");
}

function numericRotation(stream) {
  const sideDataRotation = Array.isArray(stream.side_data_list)
    ? stream.side_data_list.find((entry) => Number.isFinite(Number(entry?.rotation)))?.rotation
    : undefined;
  const rawRotation = sideDataRotation ?? stream.tags?.rotate ?? 0;
  const rotation = Number(rawRotation);
  return Number.isFinite(rotation) ? rotation : 0;
}

function hasCrop(stream) {
  return [stream.crop_top, stream.crop_bottom, stream.crop_left, stream.crop_right].some(
    (value) => Number(value ?? 0) !== 0,
  );
}

export async function probeVideoFile(filePath) {
  const environment = { ...process.env };
  delete environment.FFREPORT;
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,crop_top,crop_bottom,crop_left,crop_right:stream_tags=rotate:stream_side_data=rotation:format=duration",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", env: environment, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined;
  if (!stream) {
    return null;
  }
  const duration = Number(parsed.format?.duration);
  return {
    codec: typeof stream.codec_name === "string" ? stream.codec_name.toLowerCase() : "",
    cropped: hasCrop(stream),
    durationSeconds: Number.isFinite(duration) ? duration : null,
    height: Number(stream.height),
    rotationDegrees: numericRotation(stream),
    width: Number(stream.width),
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function probeInventoryFiles({ concurrency, files, onProgress, probe }) {
  let completed = 0;
  return mapWithConcurrency(files, concurrency, async (file) => {
    let result;
    try {
      result = { kind: "readable", video: await probe(file.filePath) };
    } catch {
      result = { kind: "probe_failed", video: null };
    }
    completed += 1;
    await onProgress({ completed, total: files.length });
    return { ...file, parsed: parseRecognizedFilename(file.filePath), probeResult: result };
  });
}
