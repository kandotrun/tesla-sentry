import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDefaultBackImpactAnalyzer,
  runCli,
  verifyBackImpactInventory,
} from "./verify-back-impact-inventory.mjs";

const scriptPath = fileURLToPath(new URL("./verify-back-impact-inventory.mjs", import.meta.url));

const possibleResult = {
  analysisDurationMs: 4_000,
  analyzedFrames: 32,
  analyzerVersion: "back-temporal-impact-v1",
  camera: "back",
  candidateTimestampMs: 2_000,
  clipId: "inventory-back",
  issues: [],
  metrics: {
    globalMotionScore: 0.72,
    impulseScore: 0.64,
    recoveryScore: 0.59,
  },
  schemaVersion: 1,
  source: "back_temporal_motion",
  status: "possible_contact",
};

const noImpactResult = {
  ...possibleResult,
  candidateTimestampMs: null,
  metrics: {
    globalMotionScore: 0.08,
    impulseScore: 0.06,
    recoveryScore: 0.03,
  },
  status: "no_impact_signal_observed",
};

function indeterminateResult(...issues) {
  return {
    ...possibleResult,
    candidateTimestampMs: null,
    issues,
    metrics: null,
    status: "indeterminate",
  };
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "back-impact-inventory-test-"));
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

async function resolveTestExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) {
      continue;
    }
    try {
      const candidate = await realpath(join(directory, name));
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("test executable unavailable");
}

async function writeExecutable(path, source) {
  await writeFile(path, source, { mode: 0o700 });
}

async function assertProcessGone(pid) {
  const deadline = Date.now() + 5_000;
  let lastState = "";
  while (Date.now() < deadline) {
    const state = spawnSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,state=", "-p", String(pid)], {
      encoding: "utf8",
    });
    lastState = state.stdout.trim();
    if (state.status !== 0 || lastState.endsWith("Z")) {
      return;
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(error.code, "ESRCH");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} is still alive: ${lastState}`);
}

test("analyzes only recognized back roles and returns anonymous counts", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    await createFiles(sourceDir, [
      "private-event-front.mp4",
      "private-event-back.mp4",
      "private-event-rear_view.mp4",
      "private-event-unknown.mp4",
    ]);

    const result = await verifyBackImpactInventory({
      analyze: async (file) =>
        file.filePath.endsWith("rear_view.mp4") ? possibleResult : noImpactResult,
      concurrency: 2,
      sourceDir,
    });

    assert.equal(result.inventory.targetBackFiles, 2);
    assert.equal(result.verdicts.possibleContact, 1);
    assert.equal(result.verdicts.noImpactSignalObserved, 1);
    assert.equal(result.sourceUnchanged, true);
    assert.doesNotMatch(JSON.stringify(result), /private-event|back\.mp4|rear_view\.mp4/);
  });
});

test("returns the exact anonymous aggregate shape", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    await createFiles(sourceDir, ["event-back.mp4", "event-rear_view.mp4"]);
    const result = await verifyBackImpactInventory({
      analyze: async (file) =>
        file.filePath.endsWith("rear_view.mp4") ? possibleResult : noImpactResult,
      concurrency: 2,
      sourceDir,
    });

    assert.deepEqual(result, {
      analyzerVersion: "back-temporal-impact-v1",
      inventory: {
        analyzedBackFiles: 2,
        readableBackFiles: 2,
        targetBackFiles: 2,
        totalBytes: 2,
      },
      issueCounts: {
        analysis_failed: 0,
        decode_failed: 0,
        frame_timing_unreliable: 0,
        insufficient_frames: 0,
        low_visibility: 0,
        unsupported_video: 0,
      },
      scoreDistribution: {
        globalMotion: { maximum: 0.72, median: 0.4, p95: 0.72 },
        impulse: { maximum: 0.64, median: 0.35, p95: 0.64 },
        recovery: { maximum: 0.59, median: 0.31, p95: 0.59 },
      },
      sourceUnchanged: true,
      verdicts: {
        indeterminate: 0,
        noImpactSignalObserved: 1,
        possibleContact: 1,
      },
    });
  });
});

test("enforces each supported concurrency limit", async () => {
  for (const concurrency of [1, 2, 3, 4]) {
    await withTemporaryDirectory(async (sourceDir) => {
      await createFiles(
        sourceDir,
        Array.from({ length: 8 }, (_, index) => `event-${index}-back.mp4`),
      );
      let active = 0;
      let maximumActive = 0;
      await verifyBackImpactInventory({
        analyze: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return noImpactResult;
        },
        concurrency,
        sourceDir,
      });
      assert.equal(maximumActive, concurrency);
    });
  }
});

test("rejects unsafe concurrency before analysis", async () => {
  for (const concurrency of [0, 5, 1.5, "2", Number.NaN]) {
    let analyzed = false;
    await assert.rejects(
      verifyBackImpactInventory({
        analyze: async () => {
          analyzed = true;
          return noImpactResult;
        },
        concurrency,
        sourceDir: "/private/source-that-must-not-be-read",
      }),
      { message: "concurrency_invalid" },
    );
    assert.equal(analyzed, false);
  }
});

test("anonymizes analyzer rejections and continues the inventory", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    await createFiles(sourceDir, ["one-back.mp4", "two-back.mp4", "three-back.mp4"]);
    let calls = 0;
    const result = await verifyBackImpactInventory({
      analyze: async () => {
        calls += 1;
        if (calls === 2) {
          throw new Error("private spawn failure");
        }
        return noImpactResult;
      },
      concurrency: 1,
      sourceDir,
    });

    assert.equal(calls, 3);
    assert.equal(result.verdicts.indeterminate, 1);
    assert.equal(result.issueCounts.analysis_failed, 1);
    assert.doesNotMatch(JSON.stringify(result), /private spawn failure|one-back/);
  });
});

test("reports progress as count-only exact objects", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    await createFiles(sourceDir, ["private-token-one-back.mp4", "private-token-two-back.mp4"]);
    const progress = [];
    await verifyBackImpactInventory({
      analyze: async () => noImpactResult,
      concurrency: 1,
      onProgress: async (value) => progress.push(value),
      sourceDir,
    });

    assert.deepEqual(progress, [
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ]);
    assert.doesNotMatch(JSON.stringify(progress), /private-token|back\.mp4|inventory-back/);
  });
});

test("leaves source contents and metadata unchanged", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    const name = "event-back.mp4";
    await createFiles(sourceDir, [name]);
    const filePath = join(sourceDir, name);
    const beforeMetadata = await stat(filePath);
    const before = {
      contents: await readFile(filePath),
      mode: beforeMetadata.mode,
      mtimeMs: beforeMetadata.mtimeMs,
      size: beforeMetadata.size,
    };
    await verifyBackImpactInventory({
      analyze: async () => noImpactResult,
      concurrency: 1,
      sourceDir,
    });
    const afterMetadata = await stat(filePath);
    assert.deepEqual(
      {
        contents: await readFile(filePath),
        mode: afterMetadata.mode,
        mtimeMs: afterMetadata.mtimeMs,
        size: afterMetadata.size,
      },
      before,
    );
  });
});

test("fails closed when source bytes, size, mtime, mode, or file set changes", async () => {
  const mutations = [
    async (_sourceDir, filePath) => writeFile(filePath, "y"),
    async (_sourceDir, filePath) => writeFile(filePath, "expanded"),
    async (_sourceDir, filePath) => {
      const metadata = await stat(filePath);
      await utimes(filePath, metadata.atime, new Date(metadata.mtimeMs + 10_000));
    },
    async (_sourceDir, filePath) => chmod(filePath, 0o600),
    async (sourceDir) => writeFile(join(sourceDir, "added-back.mp4"), "x"),
  ];
  for (const mutate of mutations) {
    await withTemporaryDirectory(async (sourceDir) => {
      const filePath = join(sourceDir, "event-back.mp4");
      await writeFile(filePath, "x");
      await assert.rejects(
        verifyBackImpactInventory({
          analyze: async () => {
            await mutate(sourceDir, filePath);
            return noImpactResult;
          },
          concurrency: 1,
          sourceDir,
        }),
        { message: "source_inventory_changed" },
      );
    });
  }
});

test("conserves verdicts and applies analyzed and readable semantics", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    await createFiles(
      sourceDir,
      Array.from({ length: 5 }, (_, index) => `event-${index}-back.mp4`),
    );
    const results = [
      possibleResult,
      noImpactResult,
      indeterminateResult("analysis_failed"),
      indeterminateResult("decode_failed"),
      indeterminateResult("low_visibility"),
    ];
    let index = 0;
    const result = await verifyBackImpactInventory({
      analyze: async () => results[index++],
      concurrency: 1,
      sourceDir,
    });

    assert.deepEqual(result.verdicts, {
      indeterminate: 3,
      noImpactSignalObserved: 1,
      possibleContact: 1,
    });
    assert.deepEqual(result.inventory, {
      analyzedBackFiles: 2,
      readableBackFiles: 3,
      targetBackFiles: 5,
      totalBytes: 5,
    });
    assert.equal(result.issueCounts.analysis_failed, 1);
    assert.equal(result.issueCounts.decode_failed, 1);
    assert.equal(result.issueCounts.low_visibility, 1);
  });
});

test("returns null score distributions for an empty target inventory", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    await createFiles(sourceDir, ["event-front.mp4", "event-unknown.mp4"]);
    const result = await verifyBackImpactInventory({
      analyze: async () => noImpactResult,
      concurrency: 4,
      sourceDir,
    });

    assert.deepEqual(result.scoreDistribution, {
      globalMotion: { maximum: null, median: null, p95: null },
      impulse: { maximum: null, median: null, p95: null },
      recovery: { maximum: null, median: null, p95: null },
    });
    assert.equal(result.inventory.targetBackFiles, 0);
  });
});

test("computes deterministic median, p95, and maximum from finite scores", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    await createFiles(
      sourceDir,
      Array.from({ length: 4 }, (_, index) => `event-${index}-back.mp4`),
    );
    const scores = [0.9, 0.1, 0.7, 0.3];
    let index = 0;
    const result = await verifyBackImpactInventory({
      analyze: async () => {
        const score = scores[index++];
        return {
          ...noImpactResult,
          metrics: {
            globalMotionScore: score,
            impulseScore: score,
            recoveryScore: score,
          },
        };
      },
      concurrency: 1,
      sourceDir,
    });

    assert.deepEqual(result.scoreDistribution, {
      globalMotion: { maximum: 0.9, median: 0.5, p95: 0.9 },
      impulse: { maximum: 0.9, median: 0.5, p95: 0.9 },
      recovery: { maximum: 0.9, median: 0.5, p95: 0.9 },
    });
  });
});

test("maps malformed and nonfinite analyzer results to anonymous failures", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    await createFiles(
      sourceDir,
      Array.from({ length: 6 }, (_, index) => `malformed-${index}-back.mp4`),
    );
    const malformed = [
      { ...possibleResult, privatePath: "/private/media.mp4" },
      {
        ...possibleResult,
        metrics: { ...possibleResult.metrics, impulseScore: Number.NaN },
      },
      { ...possibleResult, status: "unknown" },
      { ...possibleResult, clipId: "private-capture" },
      { ...possibleResult, candidateTimestampMs: 2_000.5 },
      { ...indeterminateResult("decode_failed"), issues: new Array(1) },
    ];
    let index = 0;
    const result = await verifyBackImpactInventory({
      analyze: async () => malformed[index++],
      concurrency: 1,
      sourceDir,
    });

    assert.equal(result.verdicts.indeterminate, 6);
    assert.equal(result.issueCounts.analysis_failed, 6);
    assert.equal(result.inventory.readableBackFiles, 0);
    assert.equal(JSON.stringify(result).includes("NaN"), false);
    assert.doesNotMatch(JSON.stringify(result), /private|media\.mp4|unknown/);
  });
});

test("default adapter fixes argv, environment, request, and cleans temporary data", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    const filePath = join(sourceDir, "nested/event-back.mp4");
    await createFiles(sourceDir, ["nested/event-back.mp4"]);
    let temporaryRoot = "";
    const execute = async (command, arguments_, options) => {
      assert.equal(command.startsWith("/"), true);
      assert.deepEqual(arguments_.slice(0, 3), ["-P", "-m", "sentry_analyzer.back_impact_cli"]);
      assert.equal(arguments_[arguments_.indexOf("--input-root") + 1], ".");
      assert.equal(options.cwd, sourceDir);
      assert.equal(options.env.PYTHONPATH.endsWith("containers/analyzer/src"), true);
      assert.deepEqual(Object.keys(options.env).toSorted(), [
        "LANG",
        "LC_ALL",
        "PATH",
        "PYTHONPATH",
      ]);
      assert.equal(
        options.env.PATH.split(":").every((entry) => entry.startsWith("/")),
        true,
      );
      const requestPath = arguments_[arguments_.indexOf("--request") + 1];
      const outputRoot = arguments_[arguments_.indexOf("--output-root") + 1];
      temporaryRoot = dirname(requestPath);
      assert.deepEqual(JSON.parse(await readFile(requestPath, "utf8")), {
        camera: "back",
        clipId: "inventory-back",
        relativePath: "nested/event-back.mp4",
        schemaVersion: 1,
      });
      assert.equal(arguments_.includes(filePath), false);
      await mkdir(outputRoot);
      await writeFile(join(outputRoot, "result.json"), JSON.stringify(possibleResult));
      return { exitCode: 0, signal: null, timedOut: false };
    };
    const analyze = createDefaultBackImpactAnalyzer({ execute });
    const result = await analyze({ filePath, relativePath: "nested/event-back.mp4", sourceDir });

    assert.deepEqual(result, possibleResult);
    await assert.rejects(access(temporaryRoot), { code: "ENOENT" });
  });
});

test("default adapter enforces exit-result consistency and cleans after failures", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    const file = {
      filePath: join(sourceDir, "event-back.mp4"),
      relativePath: "event-back.mp4",
      sourceDir,
    };
    await writeFile(file.filePath, "x");
    let typedRoot = "";
    const typedAnalyze = createDefaultBackImpactAnalyzer({
      execute: async (_command, arguments_) => {
        const requestPath = arguments_[arguments_.indexOf("--request") + 1];
        const outputRoot = arguments_[arguments_.indexOf("--output-root") + 1];
        typedRoot = dirname(requestPath);
        await mkdir(outputRoot);
        await writeFile(
          join(outputRoot, "result.json"),
          JSON.stringify(indeterminateResult("decode_failed")),
        );
        return { exitCode: 3, signal: null, timedOut: false };
      },
    });
    assert.deepEqual(await typedAnalyze(file), indeterminateResult("decode_failed"));
    await assert.rejects(access(typedRoot), { code: "ENOENT" });

    let failedRoot = "";
    const failedAnalyze = createDefaultBackImpactAnalyzer({
      execute: async (_command, arguments_) => {
        failedRoot = dirname(arguments_[arguments_.indexOf("--request") + 1]);
        throw new Error("private spawn path");
      },
    });
    await assert.rejects(failedAnalyze(file), { message: "analysis_failed" });
    await assert.rejects(access(failedRoot), { code: "ENOENT" });

    for (const processResult of [
      { exitCode: 2, signal: null, timedOut: false },
      { exitCode: 5, signal: null, timedOut: false },
      { exitCode: null, signal: "SIGTERM", timedOut: false },
      { exitCode: null, signal: "SIGKILL", timedOut: true },
    ]) {
      const analyze = createDefaultBackImpactAnalyzer({
        execute: async (_command, arguments_) => {
          const outputRoot = arguments_[arguments_.indexOf("--output-root") + 1];
          await mkdir(outputRoot);
          await writeFile(join(outputRoot, "result.json"), JSON.stringify(possibleResult));
          return processResult;
        },
      });
      await assert.rejects(analyze(file), { message: "analysis_failed" });
    }

    for (const [processResult, payload] of [
      [{ exitCode: 0, signal: null, timedOut: false }, indeterminateResult("decode_failed")],
      [{ exitCode: 3, signal: null, timedOut: false }, possibleResult],
    ]) {
      const analyze = createDefaultBackImpactAnalyzer({
        execute: async (_command, arguments_) => {
          const outputRoot = arguments_[arguments_.indexOf("--output-root") + 1];
          await mkdir(outputRoot);
          await writeFile(join(outputRoot, "result.json"), JSON.stringify(payload));
          return processResult;
        },
      });
      await assert.rejects(analyze(file), { message: "analysis_failed" });
    }
  });
});

test("real subprocess ignores source-local Python modules and executables", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDir = join(directory, "source");
    const safeBin = join(directory, "safe-bin");
    const marker = join(directory, "ambient-secret-marker");
    const moduleMarker = join(directory, "source-module-marker");
    const toolMarker = join(directory, "source-tool-marker");
    const python = await resolveTestExecutable("python3");
    await mkdir(join(sourceDir, "sentry_analyzer"), { recursive: true });
    await mkdir(safeBin);
    await writeFile(join(sourceDir, "event-back.mp4"), "invalid");
    await writeFile(join(sourceDir, "sentry_analyzer/__init__.py"), "");
    await writeFile(
      join(sourceDir, "sentry_analyzer/back_impact_cli.py"),
      `from pathlib import Path\nPath(${JSON.stringify(moduleMarker)}).write_text("bad")\n`,
    );
    const badTool = `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(toolMarker)}, "bad");\n`;
    for (const name of ["python3", "ffmpeg", "ffprobe"]) {
      await writeExecutable(join(sourceDir, name), badTool);
    }
    await writeExecutable(
      join(safeBin, "python3"),
      `#!${process.execPath}\nconst { spawnSync } = require("node:child_process");\nconst fs = require("node:fs");\nif (process.env.PRIVATE_AMBIENT_SENTINEL) fs.writeFileSync(${JSON.stringify(marker)}, "bad");\nconst result = spawnSync(${JSON.stringify(python)}, process.argv.slice(2), { env: process.env, stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
    );
    const environment = {
      ...process.env,
      PATH: [sourceDir, safeBin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
      PRIVATE_AMBIENT_SENTINEL: "private-secret",
    };
    const analyze = createDefaultBackImpactAnalyzer({ environment });
    const result = await analyze({
      filePath: join(sourceDir, "event-back.mp4"),
      relativePath: "event-back.mp4",
      sourceDir,
    });

    assert.equal(result.status, "indeterminate");
    await assert.rejects(access(marker), { code: "ENOENT" });
    await assert.rejects(access(moduleMarker), { code: "ENOENT" });
    await assert.rejects(access(toolMarker), { code: "ENOENT" });
  });
});

test("outer timeout kills the process group, cleans temp data, and continues", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDir = join(directory, "source");
    const safeBin = join(directory, "safe-bin");
    const descendantPidPath = join(directory, "descendant.pid");
    await mkdir(sourceDir);
    await mkdir(safeBin);
    await createFiles(sourceDir, ["hang-back.mp4", "ok-back.mp4"]);
    await writeExecutable(
      join(safeBin, "python3"),
      `#!${process.execPath}\nconst { spawn } = require("node:child_process");\nconst fs = require("node:fs");\nconst requestPath = process.argv[process.argv.indexOf("--request") + 1];\nconst outputRoot = process.argv[process.argv.indexOf("--output-root") + 1];\nconst request = JSON.parse(fs.readFileSync(requestPath, "utf8"));\nif (request.relativePath.startsWith("hang")) {\n  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n  fs.writeFileSync(${JSON.stringify(descendantPidPath)}, JSON.stringify({ parent: process.pid, child: child.pid }));\n  setInterval(() => child.pid, 1000);\n} else {\n  fs.mkdirSync(outputRoot);\n  fs.writeFileSync(outputRoot + "/result.json", ${JSON.stringify(JSON.stringify(noImpactResult))});\n}\n`,
    );
    const temporaryParent = join(directory, "analyzer-temporary");
    await mkdir(temporaryParent);
    const environment = {
      ...process.env,
      PATH: [safeBin, dirname(process.execPath)].join(delimiter),
    };
    const analyze = createDefaultBackImpactAnalyzer({
      environment,
      killGraceMs: 50,
      temporaryParent,
      timeoutMs: 500,
    });
    const started = Date.now();
    const result = await verifyBackImpactInventory({
      analyze,
      concurrency: 1,
      sourceDir,
    });
    const elapsedMs = Date.now() - started;
    const processIds = JSON.parse(await readFile(descendantPidPath, "utf8"));

    assert.equal(elapsedMs < 2_000, true);
    assert.equal(result.issueCounts.analysis_failed, 1);
    assert.equal(result.verdicts.noImpactSignalObserved, 1);
    assert.deepEqual(await readdir(temporaryParent), []);
    await assertProcessGone(processIds.child);
  });
});

test("rejects a source root symlink before analysis", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceDir = join(directory, "source");
    const linkedSource = join(directory, "linked-source");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "event-back.mp4"), "x");
    await symlink(sourceDir, linkedSource);
    let analyzed = false;

    await assert.rejects(
      verifyBackImpactInventory({
        analyze: async () => {
          analyzed = true;
          return noImpactResult;
        },
        concurrency: 1,
        sourceDir: linkedSource,
      }),
      { message: "source_directory_invalid" },
    );
    assert.equal(analyzed, false);
  });
});

test("fails closed after source root or intermediate directory identity replacement", async () => {
  for (const replaceRoot of [true, false]) {
    await withTemporaryDirectory(async (directory) => {
      const sourceDir = join(directory, "source");
      const nested = join(sourceDir, "nested");
      const filePath = join(nested, "event-back.mp4");
      await mkdir(nested, { recursive: true });
      await writeFile(filePath, "x");

      await assert.rejects(
        verifyBackImpactInventory({
          analyze: async () => {
            const replaced = replaceRoot ? sourceDir : nested;
            const moved = replaceRoot ? `${sourceDir}-old` : join(directory, "nested-old");
            await rename(replaced, moved);
            await mkdir(replaced, { recursive: true });
            const replacement = replaceRoot ? join(replaced, "nested/event-back.mp4") : filePath;
            await mkdir(dirname(replacement), { recursive: true });
            const original = replaceRoot
              ? join(moved, "nested/event-back.mp4")
              : join(moved, "event-back.mp4");
            await link(original, replacement);
            return noImpactResult;
          },
          concurrency: 1,
          sourceDir,
        }),
        { message: "source_inventory_changed" },
      );
    });
  }
});

test("CLI emits one anonymous JSON object for an empty source", async () => {
  await withTemporaryDirectory(async (sourceDir) => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        FFREPORT: `file=${join(sourceDir, "private-report.log")}`,
        PATH: process.env.PATH ?? "",
        SENTRY_SOURCE_DIR: sourceDir,
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).sourceUnchanged, true);
    assert.equal(result.stdout.includes(sourceDir), false);
  });
});

test("CLI exposes only the source-change sentinel", async () => {
  for (const [error, expected] of [
    [new Error("source_inventory_changed"), "source_inventory_changed\n"],
    [new Error("private /capture/event-back.mp4"), "inventory_verification_failed\n"],
  ]) {
    let standardError = "";
    const exitCode = await runCli({
      environment: { SENTRY_SOURCE_DIR: "/private/capture" },
      standardError: { write: (value) => (standardError += value) },
      standardOutput: { write: () => assert.fail("unexpected output") },
      verify: async () => {
        throw error;
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(standardError, expected);
  }
});
