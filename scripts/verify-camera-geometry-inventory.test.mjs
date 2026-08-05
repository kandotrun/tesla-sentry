import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveInventoryAnalyzerProcess } from "./lib/camera-geometry-inventory-input.mjs";
import * as inventoryModule from "./verify-camera-geometry-inventory.mjs";

const scriptPath = fileURLToPath(
  new URL("./verify-camera-geometry-inventory.mjs", import.meta.url),
);

const cameras = ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"];

const expectedReasonOrder = [
  "unrecognized_filename",
  "probe_failed",
  "missing_video_stream",
  "codec_mismatch",
  "resolution_mismatch",
  "rotation_mismatch",
  "cropped_input",
  "incomplete_group",
  "duplicate_camera",
];

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "camera-inventory-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function createFiles(directory, names) {
  for (const name of names) {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "x");
  }
}

function cameraFromFilename(filePath) {
  const name = basename(filePath).toLowerCase();
  if (name.endsWith("-rear_view.mp4")) {
    return "back";
  }
  return cameras.find((camera) => name.endsWith(`-${camera}.mp4`)) ?? null;
}

function compatibleProbe(filePath) {
  const camera = cameraFromFilename(filePath);
  if (basename(filePath).toLowerCase() === "event.mp4") {
    return Promise.resolve({
      codec: "mpeg4",
      cropped: false,
      durationSeconds: 10,
      height: 415,
      rotationDegrees: 0,
      width: 640,
    });
  }
  if (camera === null) {
    return Promise.resolve({
      codec: "h264",
      cropped: false,
      durationSeconds: 49,
      height: 720,
      rotationDegrees: 0,
      width: 1280,
    });
  }
  return Promise.resolve({
    codec: "h264",
    cropped: false,
    durationSeconds: 60,
    height: camera === "front" ? 1876 : 938,
    rotationDegrees: 0,
    width: camera === "front" ? 2896 : 1448,
  });
}

async function snapshotFiles(directory, names) {
  return Promise.all(
    names.map(async (name) => {
      const target = join(directory, name);
      const metadata = await stat(target);
      return {
        contents: await readFile(target, "utf8"),
        mode: metadata.mode,
        mtimeMs: metadata.mtimeMs,
        name,
        size: metadata.size,
      };
    }),
  );
}

test("CLI rejects a missing source environment without leaking an implementation path", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "SENTRY_SOURCE_DIR is required\n");
});

test("verifier groups exact suffixes, normalizes rear_view, and aggregates anonymously", async () => {
  await withTemporaryDirectory(async (directory) => {
    const names = [
      "nested/alpha-front.mp4",
      "nested/alpha-rear_view.MP4",
      "nested/alpha-left_repeater.mp4",
      "nested/alpha-right_repeater.mp4",
      "nested/alpha-left_pillar.mp4",
      "nested/alpha-right_pillar.mp4",
      "nested/beta-front.mp4",
      "nested/gamma-back.mp4",
      "nested/gamma-rear_view.mp4",
      "nested/event.mp4",
      "nested/alpha-sidecam.mp4",
    ];
    await createFiles(directory, names);

    const result = await inventoryModule.verifyCameraGeometryInventory({
      concurrency: 2,
      probe: compatibleProbe,
      sourceDir: directory,
    });

    assert.deepEqual(result, {
      cameras: {
        back: { codecs: { h264: 3 }, files: 3, resolutions: { "1448x938": 3 } },
        front: { codecs: { h264: 2 }, files: 2, resolutions: { "2896x1876": 2 } },
        left_pillar: {
          codecs: { h264: 1 },
          files: 1,
          resolutions: { "1448x938": 1 },
        },
        left_repeater: {
          codecs: { h264: 1 },
          files: 1,
          resolutions: { "1448x938": 1 },
        },
        right_pillar: {
          codecs: { h264: 1 },
          files: 1,
          resolutions: { "1448x938": 1 },
        },
        right_repeater: {
          codecs: { h264: 1 },
          files: 1,
          resolutions: { "1448x938": 1 },
        },
      },
      groups: {
        complete: 1,
        duplicate: 1,
        incomplete: 1,
        metadataCompatible: 1,
        total: 3,
      },
      incompatibilityReasons: [
        { count: 2, reason: "unrecognized_filename" },
        { count: 0, reason: "probe_failed" },
        { count: 0, reason: "missing_video_stream" },
        { count: 0, reason: "codec_mismatch" },
        { count: 0, reason: "resolution_mismatch" },
        { count: 0, reason: "rotation_mismatch" },
        { count: 0, reason: "cropped_input" },
        { count: 1, reason: "incomplete_group" },
        { count: 1, reason: "duplicate_camera" },
      ],
      inventory: {
        durationSeconds: { max: 60, min: 10 },
        readableFiles: 11,
        recognizedSuffixFiles: 9,
        shortClipsUnder50Seconds: 2,
        totalBytes: 11,
        totalFiles: 11,
        unknownSuffixFiles: 2,
        unreadableFiles: 0,
      },
      metadataCompatibleFiles: 9,
      profileId: "model-y-2025-plus-long-range-2896x1876-v2",
    });
  });
});

test("verifier compares all six container metadata roles with fixed incompatibility ordering", async () => {
  await withTemporaryDirectory(async (directory) => {
    const names = cameras.map((camera) => `event-one-${camera}.mp4`);
    await createFiles(directory, names);

    const result = await inventoryModule.verifyCameraGeometryInventory({
      concurrency: 2,
      probe: async (filePath) => {
        const camera = cameraFromFilename(filePath);
        if (camera === "right_pillar") {
          throw new Error("private probe detail");
        }
        if (camera === "left_pillar") {
          return null;
        }
        const compatible = await compatibleProbe(filePath);
        if (camera === "front") {
          return { ...compatible, codec: "hevc" };
        }
        if (camera === "back") {
          return { ...compatible, width: 1920 };
        }
        if (camera === "left_repeater") {
          return { ...compatible, rotationDegrees: 90 };
        }
        if (camera === "right_repeater") {
          return { ...compatible, cropped: true };
        }
        return compatible;
      },
      sourceDir: directory,
    });

    assert.deepEqual(
      result.incompatibilityReasons.map(({ reason }) => reason),
      expectedReasonOrder,
    );
    assert.deepEqual(
      Object.fromEntries(result.incompatibilityReasons.map(({ count, reason }) => [reason, count])),
      {
        codec_mismatch: 1,
        cropped_input: 1,
        duplicate_camera: 0,
        incomplete_group: 0,
        missing_video_stream: 1,
        probe_failed: 1,
        resolution_mismatch: 1,
        rotation_mismatch: 1,
        unrecognized_filename: 0,
      },
    );
    assert.deepEqual(result.groups, {
      complete: 1,
      duplicate: 0,
      incomplete: 0,
      metadataCompatible: 0,
      total: 1,
    });
    assert.equal(result.inventory.readableFiles, 5);
    assert.equal(result.inventory.unreadableFiles, 1);
    assert.equal(result.metadataCompatibleFiles, 0);
    assert.doesNotMatch(JSON.stringify(result), /private probe detail|event-one/);
  });
});

test("verifier bounds probe concurrency, redacts identifiers, and leaves sources unchanged", async () => {
  await withTemporaryDirectory(async (directory) => {
    const names = Array.from(
      { length: 12 },
      (_, index) => `private-capture-marker-${index}-unknown.MP4`,
    );
    await createFiles(directory, names);
    const before = await snapshotFiles(directory, names);
    let active = 0;
    let maximumActive = 0;

    const result = await inventoryModule.verifyCameraGeometryInventory({
      concurrency: 3,
      probe: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          codec: "h264",
          cropped: false,
          durationSeconds: 50,
          height: 720,
          rotationDegrees: 0,
          width: 1280,
        };
      },
      sourceDir: directory,
    });
    const after = await snapshotFiles(directory, names);
    const serialized = JSON.stringify(result);

    assert.equal(maximumActive, 3);
    assert.equal(result.inventory.totalFiles, 12);
    assert.equal(result.inventory.unknownSuffixFiles, 12);
    assert.deepEqual(after, before);
    assert.doesNotMatch(serialized, /private-capture-marker|unknown\.MP4/);
    assert.equal(serialized.includes(directory), false);
  });
});

test("CLI prevents an inherited FFREPORT from writing into the source directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    await createFiles(directory, ["synthetic-front.mp4"]);
    const reportPath = join(directory, "inherited-ffreport.log");
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        FFREPORT: `file=${reportPath}:level=32`,
        PATH: process.env.PATH ?? "",
        SENTRY_SOURCE_DIR: directory,
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(
      JSON.parse(result.stdout).incompatibilityReasons.find(
        ({ reason }) => reason === "probe_failed",
      )?.count,
      1,
    );
    await assert.rejects(access(reportPath), { code: "ENOENT" });
  });
});

test("verifier rejects invalid source directories and unsafe concurrency without path disclosure", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "not-a-directory");
    await writeFile(filePath, "x");

    await assert.rejects(
      inventoryModule.verifyCameraGeometryInventory({
        concurrency: 1,
        probe: compatibleProbe,
        sourceDir: filePath,
      }),
      { message: "source_directory_invalid" },
    );
    await assert.rejects(
      inventoryModule.verifyCameraGeometryInventory({
        concurrency: 0,
        probe: compatibleProbe,
        sourceDir: directory,
      }),
      { message: "concurrency_invalid" },
    );
  });
});

test("CLI emits one deterministic JSON object and no stderr for a valid empty source", async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        SENTRY_FFPROBE_CONCURRENCY: "2",
        SENTRY_SOURCE_DIR: directory,
      },
    });
    const second = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        SENTRY_FFPROBE_CONCURRENCY: "2",
        SENTRY_SOURCE_DIR: directory,
      },
    });

    assert.equal(first.status, 0);
    assert.equal(first.stderr, "");
    assert.equal(first.stdout, second.stdout);
    assert.deepEqual(JSON.parse(first.stdout), {
      cameras: Object.fromEntries(
        cameras.map((camera) => [camera, { codecs: {}, files: 0, resolutions: {} }]),
      ),
      groups: {
        complete: 0,
        duplicate: 0,
        incomplete: 0,
        metadataCompatible: 0,
        total: 0,
      },
      incompatibilityReasons: expectedReasonOrder.map((reason) => ({ count: 0, reason })),
      inventory: {
        durationSeconds: { max: null, min: null },
        readableFiles: 0,
        recognizedSuffixFiles: 0,
        shortClipsUnder50Seconds: 0,
        totalBytes: 0,
        totalFiles: 0,
        unknownSuffixFiles: 0,
        unreadableFiles: 0,
      },
      metadataCompatibleFiles: 0,
      profileId: "model-y-2025-plus-long-range-2896x1876-v2",
    });
    assert.equal(first.stdout.endsWith("\n"), true);
    assert.equal(first.stdout.trim().split("\n").length, 1);
  });
});

test("module import is side-effect free", async () => {
  const moduleUrl = `${pathToFileURL(scriptPath).href}?test=${Date.now()}`;
  const originalExitCode = process.exitCode;
  const imported = await import(moduleUrl);

  assert.equal(typeof imported.verifyCameraGeometryInventory, "function");
  assert.equal(process.exitCode, originalExitCode);
});

test("analyzer executable discovery skips an absent candidate", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDir = join(directory, "source");
    const executableDir = join(directory, "bin");
    const executable = join(executableDir, "python3");
    await mkdir(sourceDir);
    await mkdir(executableDir);
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    const result = await resolveInventoryAnalyzerProcess({
      environment: { PATH: [join(directory, "absent"), executableDir].join(delimiter) },
      executableName: "python3",
      pythonPath: join(directory, "python"),
      sourceDir,
    });

    assert.equal(result.executable, await realpath(executable));
  });
});

test("analyzer executable discovery propagates unexpected filesystem errors", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDir = join(directory, "source");
    await mkdir(sourceDir);
    const oversizedPath = `/${"x".repeat(10_000)}`;

    await assert.rejects(
      resolveInventoryAnalyzerProcess({
        environment: { PATH: oversizedPath },
        executableName: "python3",
        pythonPath: join(directory, "python"),
        sourceDir,
      }),
      { code: "ENAMETOOLONG" },
    );
  });
});
