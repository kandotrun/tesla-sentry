import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseBackImpactResult,
  verifyBackImpactInventory as verifyInventory,
} from "./lib/back-impact-inventory.mjs";
import { resolveInventoryAnalyzerProcess } from "./lib/camera-geometry-inventory-input.mjs";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 135_000;
const ANALYZER_SOURCE = fileURLToPath(new URL("../containers/analyzer/src", import.meta.url));

function signalProcess(child, processGroupId, signal) {
  try {
    return processGroupId ? process.kill(-processGroupId, signal) : child.kill(signal);
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

function executeProcess(command, arguments_, options) {
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    let callbackResult = null;
    let killFinished = false;
    let timedOut = false;
    const finish = () => {
      if (callbackResult !== null && (!timedOut || killFinished)) {
        resolve({ ...callbackResult, timedOut });
      }
    };
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      detached,
      env: options.env,
      stdio: "ignore",
    });
    const processGroupId = detached ? child.pid : undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalProcess(child, processGroupId, "SIGTERM");
      setTimeout(() => {
        signalProcess(child, processGroupId, "SIGKILL");
        killFinished = true;
        finish();
      }, options.killGraceMs);
    }, options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timeoutTimer);
      callbackResult = { exitCode: null, signal: null };
      finish();
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeoutTimer);
      callbackResult ??= { exitCode, signal };
      finish();
    });
  });
}

function exitMatchesResult(processResult, result) {
  if (processResult.timedOut || processResult.signal !== null) {
    return false;
  }
  if (processResult.exitCode === 0) {
    return result.status === "possible_contact" || result.status === "no_impact_signal_observed";
  }
  return processResult.exitCode === 3 && result.status === "indeterminate";
}

export function createDefaultBackImpactAnalyzer({
  environment = process.env,
  execute = executeProcess,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  temporaryParent = tmpdir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return async function analyze(file) {
    const processContext = await resolveInventoryAnalyzerProcess({
      environment,
      executableName: "python3",
      pythonPath: ANALYZER_SOURCE,
      sourceDir: file.sourceDir,
    });
    const temporaryRoot = await mkdtemp(join(temporaryParent, "back-impact-inventory-"));
    const requestPath = join(temporaryRoot, "request.json");
    const outputRoot = join(temporaryRoot, "output");
    const resultPath = join(outputRoot, "result.json");
    try {
      await writeFile(
        requestPath,
        JSON.stringify({
          camera: "back",
          clipId: "inventory-back",
          relativePath: file.relativePath,
          schemaVersion: 1,
        }),
        { mode: 0o600 },
      );
      const processResult = await execute(
        processContext.executable,
        [
          "-P",
          "-m",
          "sentry_analyzer.back_impact_cli",
          "--request",
          requestPath,
          "--input-root",
          ".",
          "--output-root",
          outputRoot,
        ],
        {
          cwd: file.sourceDir,
          env: processContext.environment,
          killGraceMs,
          timeoutMs,
        },
      );
      if (
        processResult.timedOut ||
        processResult.signal !== null ||
        (processResult.exitCode !== 0 && processResult.exitCode !== 3)
      ) {
        throw new Error("analysis_failed");
      }
      const payload = JSON.parse(await readFile(resultPath, "utf8"));
      const result = parseBackImpactResult(payload);
      if (!exitMatchesResult(processResult, result)) {
        throw new Error("analysis_failed");
      }
      return result;
    } catch {
      throw new Error("analysis_failed");
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  };
}

const defaultAnalyzer = createDefaultBackImpactAnalyzer();

export async function verifyBackImpactInventory({
  analyze = defaultAnalyzer,
  concurrency = DEFAULT_CONCURRENCY,
  onProgress,
  sourceDir,
}) {
  return verifyInventory({ analyze, concurrency, onProgress, sourceDir });
}

export async function runCli({
  environment = process.env,
  standardError = process.stderr,
  standardOutput = process.stdout,
  verify = verifyBackImpactInventory,
} = {}) {
  const sourceDir = environment.SENTRY_SOURCE_DIR?.trim();
  if (!sourceDir) {
    standardError.write("SENTRY_SOURCE_DIR is required\n");
    return 1;
  }
  const rawConcurrency = environment.SENTRY_BACK_IMPACT_CONCURRENCY;
  const concurrency = rawConcurrency === undefined ? DEFAULT_CONCURRENCY : Number(rawConcurrency);
  try {
    const result = await verify({ concurrency, sourceDir });
    standardOutput.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const message =
      error instanceof Error && error.message === "source_inventory_changed"
        ? "source_inventory_changed"
        : "inventory_verification_failed";
    standardError.write(`${message}\n`);
    return 1;
  }
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  process.exitCode = await runCli();
}
