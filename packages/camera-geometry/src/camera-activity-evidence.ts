import type {
  CameraActivityCamera,
  CameraActivityDirectionEvidence,
  CameraActivityEventEvidence,
  CameraActivityEvidence,
  CameraActivityIssue,
  CameraActivityMetrics,
  CameraActivityStatus,
  NonEmpty,
} from "./types";

const DIRECTION_KEYS = [
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

const EVENT_KEYS = [
  "analyzerVersion",
  "cameras",
  "eventId",
  "schemaVersion",
  "source",
  "status",
] as const;

const METRICS_KEYS = [
  "changedPixelRatio",
  "gradientChangeRatio",
  "nearCameraScore",
  "qualifyingSamples",
] as const;

const CAMERA_ORDER = [
  "front",
  "back",
  "left_repeater",
  "right_repeater",
  "left_pillar",
  "right_pillar",
] as const satisfies readonly CameraActivityCamera[];

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNormalizedScore(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isCamera(value: unknown): value is CameraActivityCamera {
  return CAMERA_ORDER.some((camera) => camera === value);
}

function isIssue(value: unknown): value is CameraActivityIssue {
  return (
    value === "analysis_failed" ||
    value === "decode_failed" ||
    value === "frame_timing_unreliable" ||
    value === "insufficient_frames" ||
    value === "low_visibility" ||
    value === "unsupported_video"
  );
}

function isNonEmptyIssueList(value: unknown): value is NonEmpty<CameraActivityIssue> {
  return Array.isArray(value) && value.length > 0 && arrayHasNoHoles(value) && value.every(isIssue);
}

function isEmptyList(value: unknown): value is readonly [] {
  return Array.isArray(value) && value.length === 0;
}

function isMetrics(value: unknown): value is CameraActivityMetrics {
  return (
    isRecord(value) &&
    hasExactKeys(value, METRICS_KEYS) &&
    isNormalizedScore(value.changedPixelRatio) &&
    isNormalizedScore(value.gradientChangeRatio) &&
    isNormalizedScore(value.nearCameraScore) &&
    isSafeNonNegativeInteger(value.qualifyingSamples)
  );
}

function isValidCandidateTimestamp(value: unknown, duration: unknown): boolean {
  return isSafeNonNegativeInteger(value) && typeof duration === "number" && value <= duration;
}

function hasValidDirectionBase(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isSafeNonNegativeInteger(value.analysisDurationMs) &&
    isSafeNonNegativeInteger(value.analyzedFrames) &&
    value.analyzerVersion === "camera-temporal-activity-v1" &&
    isCamera(value.camera) &&
    typeof value.clipId === "string" &&
    SAFE_IDENTIFIER.test(value.clipId) &&
    value.schemaVersion === 1 &&
    value.source === "camera_temporal_activity"
  );
}

function isDirection(value: unknown): value is CameraActivityDirectionEvidence {
  if (!isRecord(value) || !hasExactKeys(value, DIRECTION_KEYS) || !hasValidDirectionBase(value)) {
    return false;
  }
  switch (value.status) {
    case "activity_detected":
      return (
        isValidCandidateTimestamp(value.candidateTimestampMs, value.analysisDurationMs) &&
        isEmptyList(value.issues) &&
        isMetrics(value.metrics)
      );
    case "no_activity_signal_observed":
      return (
        value.candidateTimestampMs === null && isEmptyList(value.issues) && isMetrics(value.metrics)
      );
    case "indeterminate":
      return (
        value.candidateTimestampMs === null &&
        isNonEmptyIssueList(value.issues) &&
        value.metrics === null
      );
    default:
      return false;
  }
}

function aggregateStatus(
  cameras: readonly CameraActivityDirectionEvidence[],
): CameraActivityStatus {
  if (cameras.some((camera) => camera.status === "activity_detected")) {
    return "activity_detected";
  }
  if (cameras.some((camera) => camera.status === "indeterminate")) {
    return "indeterminate";
  }
  return "no_activity_signal_observed";
}

export function isCameraActivityEventEvidence(
  value: unknown,
): value is CameraActivityEventEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, EVENT_KEYS) ||
    value.analyzerVersion !== "camera-temporal-activity-v1" ||
    typeof value.eventId !== "string" ||
    !SAFE_IDENTIFIER.test(value.eventId) ||
    value.schemaVersion !== 1 ||
    value.source !== "camera_temporal_activity" ||
    !Array.isArray(value.cameras) ||
    value.cameras.length !== CAMERA_ORDER.length ||
    !arrayHasNoHoles(value.cameras) ||
    !value.cameras.every(isDirection)
  ) {
    return false;
  }
  const cameras = value.cameras;
  return (
    cameras.every((camera, index) => camera.camera === CAMERA_ORDER[index]) &&
    value.status === aggregateStatus(cameras)
  );
}

export function isCameraActivityEvidence(value: unknown): value is CameraActivityEvidence {
  return isDirection(value) || isCameraActivityEventEvidence(value);
}

export function parseCameraActivityEvidence(value: unknown): CameraActivityEvidence {
  if (!isCameraActivityEvidence(value)) {
    throw new TypeError("invalid camera activity evidence");
  }
  return value;
}
