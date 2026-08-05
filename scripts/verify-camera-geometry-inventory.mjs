import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { aggregateCameraGeometryInventory } from "./lib/camera-geometry-inventory-aggregate.mjs";
import {
  discoverMp4Files,
  probeInventoryFiles,
  probeVideoFile,
} from "./lib/camera-geometry-inventory-input.mjs";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

export async function verifyCameraGeometryInventory({
  concurrency = DEFAULT_CONCURRENCY,
  onProgress = () => {},
  probe = probeVideoFile,
  sourceDir,
}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error("concurrency_invalid");
  }
  try {
    const sourceMetadata = await stat(sourceDir);
    if (!sourceMetadata.isDirectory()) {
      throw new Error("source_directory_invalid");
    }
  } catch {
    throw new Error("source_directory_invalid");
  }

  let files;
  try {
    files = await discoverMp4Files(sourceDir);
  } catch {
    throw new Error("source_inventory_failed");
  }

  const probed = await probeInventoryFiles({ concurrency, files, onProgress, probe });
  return aggregateCameraGeometryInventory(probed);
}

async function runCli() {
  const sourceDir = process.env.SENTRY_SOURCE_DIR?.trim();
  if (!sourceDir) {
    process.stderr.write("SENTRY_SOURCE_DIR is required\n");
    process.exitCode = 1;
    return;
  }
  const rawConcurrency = process.env.SENTRY_FFPROBE_CONCURRENCY;
  const concurrency = rawConcurrency === undefined ? DEFAULT_CONCURRENCY : Number(rawConcurrency);
  try {
    const result = await verifyCameraGeometryInventory({ concurrency, sourceDir });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("inventory_verification_failed\n");
    process.exitCode = 1;
  }
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await runCli();
}
