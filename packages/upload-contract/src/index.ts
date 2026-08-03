import type { ManifestWarning, TeslaCamera, TeslaCamManifest } from "@sentry-check/teslacam-parser";
import {
  classifyVideoMetadata,
  type VideoPreflightCode,
  type VideoPreflightResult,
} from "@sentry-check/video-preflight";

export const UPLOAD_PLAN_SCHEMA_VERSION = 1;

export type UploadEligibilityStatus = "eligible" | "pending" | "blocked";

export type UploadIneligibilityReason =
  | Exclude<VideoPreflightCode, "ready">
  | "missing_preflight"
  | "duplicate_fingerprint"
  | "duplicate_preflight";

export interface UploadPreflightRecordV1 {
  readonly fingerprint: string;
  readonly result: VideoPreflightResult;
}

export interface UploadPlanItemV1 {
  readonly eventId: string;
  readonly fingerprint: string;
  readonly name: string;
  readonly relativePath: string;
  readonly size: number;
  readonly camera: TeslaCamera;
  readonly capturedAt: string | null;
  readonly status: UploadEligibilityStatus;
  readonly ineligibilityReason: UploadIneligibilityReason | null;
  readonly warningCodes: readonly ManifestWarning["code"][];
  readonly preflight: VideoPreflightResult | null;
}

export interface UploadPlanV1 {
  readonly schemaVersion: 1;
  readonly items: readonly UploadPlanItemV1[];
  readonly totals: {
    readonly sourceClips: number;
    readonly eligibleClips: number;
    readonly eligibleBytes: number;
    readonly eligibleDurationSeconds: number;
    readonly pendingClips: number;
    readonly blockedClips: number;
  };
}

type WarningCode = ManifestWarning["code"];

const WARNING_CODE_ORDER: readonly WarningCode[] = [
  "empty_file",
  "unknown_camera",
  "unknown_scope",
  "unrecognized_filename",
  "unsafe_path",
];

function indexWarnings(
  warnings: readonly ManifestWarning[],
): ReadonlyMap<string, ReadonlySet<WarningCode>> {
  const warningsByPath = new Map<string, Set<WarningCode>>();
  for (const warning of warnings) {
    const codes = warningsByPath.get(warning.relativePath);
    if (codes) {
      codes.add(warning.code);
    } else {
      warningsByPath.set(warning.relativePath, new Set([warning.code]));
    }
  }
  return warningsByPath;
}

function indexPreflightRecords(
  records: readonly UploadPreflightRecordV1[],
): ReadonlyMap<string, readonly VideoPreflightResult[]> {
  const recordsByFingerprint = new Map<string, VideoPreflightResult[]>();
  for (const record of records) {
    const matchingRecords = recordsByFingerprint.get(record.fingerprint);
    if (matchingRecords) {
      matchingRecords.push(record.result);
    } else {
      recordsByFingerprint.set(record.fingerprint, [record.result]);
    }
  }
  return recordsByFingerprint;
}

function warningCodesFor(
  relativePath: string,
  warningsByPath: ReadonlyMap<string, ReadonlySet<WarningCode>>,
): readonly WarningCode[] {
  const codes = warningsByPath.get(relativePath);
  return codes ? WARNING_CODE_ORDER.filter((code) => codes.has(code)) : [];
}

function isFinitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function claimedReadyIneligibilityReason(
  result: VideoPreflightResult,
): UploadIneligibilityReason | null {
  const reclassified = classifyVideoMetadata(result);
  if (reclassified.code !== "ready") {
    return reclassified.code;
  }
  if (
    !isFinitePositive(result.durationSeconds) ||
    !isFinitePositive(result.width) ||
    !isFinitePositive(result.height) ||
    !Number.isFinite(result.scannedBytes) ||
    result.scannedBytes < 0
  ) {
    return "metadata_not_found";
  }
  return null;
}

export function buildUploadPlanV1(
  manifest: TeslaCamManifest,
  records: readonly UploadPreflightRecordV1[],
): UploadPlanV1 {
  const warningsByPath = indexWarnings(manifest.warnings);
  const recordsByFingerprint = indexPreflightRecords(records);
  const seenFingerprints = new Set<string>();
  const items: UploadPlanItemV1[] = [];

  for (const event of manifest.events) {
    for (const clip of event.clips) {
      const matchingRecords = recordsByFingerprint.get(clip.fingerprint) ?? [];
      const preflight = matchingRecords.length === 1 ? (matchingRecords[0] ?? null) : null;
      let status: UploadEligibilityStatus;
      let ineligibilityReason: UploadIneligibilityReason | null;

      if (seenFingerprints.has(clip.fingerprint)) {
        status = "blocked";
        ineligibilityReason = "duplicate_fingerprint";
      } else {
        seenFingerprints.add(clip.fingerprint);
        if (matchingRecords.length > 1) {
          status = "blocked";
          ineligibilityReason = "duplicate_preflight";
        } else if (!preflight) {
          status = "pending";
          ineligibilityReason = "missing_preflight";
        } else if (preflight.code !== "ready") {
          status = "blocked";
          ineligibilityReason = preflight.code;
        } else {
          ineligibilityReason = claimedReadyIneligibilityReason(preflight);
          status = ineligibilityReason ? "blocked" : "eligible";
        }
      }

      items.push({
        ineligibilityReason,
        camera: clip.camera,
        capturedAt: clip.capturedAt,
        eventId: event.id,
        fingerprint: clip.fingerprint,
        name: clip.name,
        preflight,
        relativePath: clip.relativePath,
        size: clip.size,
        status,
        warningCodes: warningCodesFor(clip.relativePath, warningsByPath),
      });
    }
  }

  let eligibleClips = 0;
  let eligibleBytes = 0;
  let eligibleDurationSeconds = 0;
  let pendingClips = 0;
  let blockedClips = 0;
  for (const item of items) {
    if (item.status === "eligible") {
      eligibleClips += 1;
      eligibleBytes += item.size;
      eligibleDurationSeconds += item.preflight?.durationSeconds ?? 0;
    } else if (item.status === "pending") {
      pendingClips += 1;
    } else {
      blockedClips += 1;
    }
  }

  return {
    schemaVersion: UPLOAD_PLAN_SCHEMA_VERSION,
    items,
    totals: {
      sourceClips: items.length,
      eligibleClips,
      eligibleBytes,
      eligibleDurationSeconds,
      pendingClips,
      blockedClips,
    },
  };
}
