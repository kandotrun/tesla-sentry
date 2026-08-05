import {
  discoverMp4Inventory,
  parseRecognizedFilename,
} from "./camera-geometry-inventory-input.mjs";

const ANALYZER_VERSION = "back-temporal-impact-v1";
const RESULT_KEYS = [
  "analysisDurationMs",
  "analyzedFrames",
  "analyzerVersion",
  "camera",
  "candidateTimestampMs",
  "clipId",
  "issues",
  "metrics",
  "schemaVersion",
  "source",
  "status",
];
const METRIC_KEYS = ["globalMotionScore", "impulseScore", "recoveryScore"];
const ISSUE_ORDER = [
  "analysis_failed",
  "decode_failed",
  "frame_timing_unreliable",
  "insufficient_frames",
  "low_visibility",
  "unsupported_video",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function isScore(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isMetrics(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, METRIC_KEYS) &&
    isScore(value.globalMotionScore) &&
    isScore(value.impulseScore) &&
    isScore(value.recoveryScore)
  );
}

function isIssueList(value, empty) {
  if (!Array.isArray(value) || (empty ? value.length !== 0 : value.length === 0)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !ISSUE_ORDER.includes(value[index])) {
      return false;
    }
  }
  return true;
}

export function parseBackImpactResult(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RESULT_KEYS) ||
    !isSafeNonNegativeInteger(value.analysisDurationMs) ||
    !isSafeNonNegativeInteger(value.analyzedFrames) ||
    value.analyzerVersion !== ANALYZER_VERSION ||
    value.camera !== "back" ||
    value.clipId !== "inventory-back" ||
    value.schemaVersion !== 1 ||
    value.source !== "back_temporal_motion"
  ) {
    throw new Error("analysis_failed");
  }
  if (value.status === "possible_contact") {
    if (
      !isSafeNonNegativeInteger(value.candidateTimestampMs) ||
      value.candidateTimestampMs > value.analysisDurationMs ||
      !isIssueList(value.issues, true) ||
      !isMetrics(value.metrics)
    ) {
      throw new Error("analysis_failed");
    }
    return value;
  }
  if (value.status === "no_impact_signal_observed") {
    if (
      value.candidateTimestampMs !== null ||
      !isIssueList(value.issues, true) ||
      !isMetrics(value.metrics)
    ) {
      throw new Error("analysis_failed");
    }
    return value;
  }
  if (
    value.status === "indeterminate" &&
    value.candidateTimestampMs === null &&
    isIssueList(value.issues, false) &&
    value.metrics === null
  ) {
    return value;
  }
  throw new Error("analysis_failed");
}

function analysisFailure() {
  return {
    analysisDurationMs: 0,
    analyzedFrames: 0,
    analyzerVersion: ANALYZER_VERSION,
    camera: "back",
    candidateTimestampMs: null,
    clipId: "inventory-back",
    issues: ["analysis_failed"],
    metrics: null,
    schemaVersion: 1,
    source: "back_temporal_motion",
    status: "indeterminate",
  };
}

function distribution(values) {
  const sorted = values.toSorted((left, right) => left - right);
  if (sorted.length === 0) {
    return { maximum: null, median: null, p95: null };
  }
  const middle = Math.floor(sorted.length / 2);
  const rawMedian =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    maximum: sorted[sorted.length - 1],
    median: Number(rawMedian.toFixed(12)),
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function snapshot(inventory) {
  return {
    directories: inventory.directories,
    files: inventory.files.map((file) => ({
      device: file.device,
      inode: file.inode,
      mode: file.mode,
      mtimeMs: file.mtimeMs,
      relativePath: file.relativePath,
      size: file.size,
    })),
    root: inventory.root,
  };
}

async function initialInventory(sourceDir) {
  try {
    return await discoverMp4Inventory(sourceDir);
  } catch (error) {
    if (error instanceof Error && error.message === "source_directory_invalid") {
      throw new Error("source_directory_invalid");
    }
    throw new Error("source_inventory_failed");
  }
}

async function analyzeTargets({ analyze, concurrency, onProgress, sourceDir, targets }) {
  const results = new Array(targets.length);
  let completed = 0;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < targets.length) {
      const index = nextIndex;
      nextIndex += 1;
      const file = targets[index];
      try {
        results[index] = parseBackImpactResult(
          await analyze({
            ...file,
            relativePath: file.relativePath,
            sourceDir,
          }),
        );
      } catch {
        results[index] = analysisFailure();
      }
      completed += 1;
      await onProgress({ completed, total: targets.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  return results;
}

function aggregate(targets, results) {
  const verdicts = {
    indeterminate: results.filter((result) => result.status === "indeterminate").length,
    noImpactSignalObserved: results.filter(
      (result) => result.status === "no_impact_signal_observed",
    ).length,
    possibleContact: results.filter((result) => result.status === "possible_contact").length,
  };
  const metrics = results.flatMap((result) => (result.metrics === null ? [] : [result.metrics]));
  const issueCounts = Object.fromEntries(
    ISSUE_ORDER.map((issue) => [
      issue,
      results.reduce((count, result) => count + (result.issues.includes(issue) ? 1 : 0), 0),
    ]),
  );
  return {
    analyzerVersion: ANALYZER_VERSION,
    inventory: {
      analyzedBackFiles: verdicts.possibleContact + verdicts.noImpactSignalObserved,
      readableBackFiles: results.filter(
        (result) =>
          !result.issues.includes("analysis_failed") && !result.issues.includes("decode_failed"),
      ).length,
      targetBackFiles: targets.length,
      totalBytes: targets.reduce((total, file) => total + file.size, 0),
    },
    issueCounts,
    scoreDistribution: {
      globalMotion: distribution(metrics.map((value) => value.globalMotionScore)),
      impulse: distribution(metrics.map((value) => value.impulseScore)),
      recovery: distribution(metrics.map((value) => value.recoveryScore)),
    },
    sourceUnchanged: true,
    verdicts,
  };
}

export async function verifyBackImpactInventory({
  analyze,
  concurrency,
  onProgress = () => {},
  sourceDir,
}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("concurrency_invalid");
  }
  const inventory = await initialInventory(sourceDir);
  const before = snapshot(inventory);
  const targets = inventory.files.filter(
    (file) => parseRecognizedFilename(file.filePath)?.camera === "back",
  );
  const results = await analyzeTargets({ analyze, concurrency, onProgress, sourceDir, targets });
  let after;
  try {
    after = snapshot(await discoverMp4Inventory(sourceDir));
  } catch {
    throw new Error("source_inventory_changed");
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("source_inventory_changed");
  }
  return aggregate(targets, results);
}
