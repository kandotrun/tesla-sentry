import type { BackImpactEvidence, BackImpactIssue, BackImpactMetrics, NonEmpty } from "./types";

const BACK_IMPACT_EVIDENCE_KEYS = [
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
] as const;

const BACK_IMPACT_METRICS_KEYS = ["globalMotionScore", "impulseScore", "recoveryScore"] as const;

const SAFE_CLIP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
}

function arrayHasNoHoles(values: readonly unknown[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index)) {
      return false;
    }
  }
  return true;
}

function isSafeNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNormalizedScore(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isBackImpactIssue(value: unknown): value is BackImpactIssue {
  return (
    value === "analysis_failed" ||
    value === "decode_failed" ||
    value === "frame_timing_unreliable" ||
    value === "insufficient_frames" ||
    value === "low_visibility" ||
    value === "unsupported_video"
  );
}

function isNonEmptyBackImpactIssueList(value: unknown): value is NonEmpty<BackImpactIssue> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    arrayHasNoHoles(value) &&
    value.every(isBackImpactIssue)
  );
}

function isEmptyIssueList(value: unknown): value is readonly [] {
  return Array.isArray(value) && value.length === 0;
}

function isBackImpactMetrics(value: unknown): value is BackImpactMetrics {
  return (
    isRecord(value) &&
    hasExactKeys(value, BACK_IMPACT_METRICS_KEYS) &&
    isNormalizedScore(value.globalMotionScore) &&
    isNormalizedScore(value.impulseScore) &&
    isNormalizedScore(value.recoveryScore)
  );
}

function hasValidBaseFields(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isSafeNonNegativeInteger(value.analysisDurationMs) &&
    isSafeNonNegativeInteger(value.analyzedFrames) &&
    value.analyzerVersion === "back-temporal-impact-v1" &&
    value.camera === "back" &&
    typeof value.clipId === "string" &&
    SAFE_CLIP_ID.test(value.clipId) &&
    value.schemaVersion === 1 &&
    value.source === "back_temporal_motion"
  );
}

function isValidCandidateTimestamp(value: unknown, analysisDurationMs: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    typeof analysisDurationMs === "number" &&
    value <= analysisDurationMs
  );
}

export function isBackImpactEvidence(value: unknown): value is BackImpactEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, BACK_IMPACT_EVIDENCE_KEYS) ||
    !hasValidBaseFields(value)
  ) {
    return false;
  }

  switch (value.status) {
    case "possible_contact":
      return (
        isValidCandidateTimestamp(value.candidateTimestampMs, value.analysisDurationMs) &&
        isEmptyIssueList(value.issues) &&
        isBackImpactMetrics(value.metrics)
      );
    case "no_impact_signal_observed":
      return (
        value.candidateTimestampMs === null &&
        isEmptyIssueList(value.issues) &&
        isBackImpactMetrics(value.metrics)
      );
    case "indeterminate":
      return (
        value.candidateTimestampMs === null &&
        isNonEmptyBackImpactIssueList(value.issues) &&
        value.metrics === null
      );
    default:
      return false;
  }
}

export function parseBackImpactEvidence(value: unknown): BackImpactEvidence {
  if (!isBackImpactEvidence(value)) {
    throw new TypeError("invalid back impact evidence");
  }
  return value;
}
