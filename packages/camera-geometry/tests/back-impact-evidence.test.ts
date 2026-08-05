import { describe, expect, it } from "vitest";
import { isBackImpactEvidence, parseBackImpactEvidence } from "../src/index";

const POSSIBLE = {
  analysisDurationMs: 4_000,
  analyzedFrames: 32,
  analyzerVersion: "back-temporal-impact-v1",
  camera: "back",
  candidateTimestampMs: 2_000,
  clipId: "back-001",
  issues: [],
  metrics: {
    globalMotionScore: 0.72,
    impulseScore: 0.64,
    recoveryScore: 0.59,
  },
  schemaVersion: 1,
  source: "back_temporal_motion",
  status: "possible_contact",
} as const;

const NO_IMPACT_SIGNAL_OBSERVED = {
  ...POSSIBLE,
  candidateTimestampMs: null,
  status: "no_impact_signal_observed",
} as const;

const INDETERMINATE = {
  ...POSSIBLE,
  candidateTimestampMs: null,
  issues: ["low_visibility"],
  metrics: null,
  status: "indeterminate",
} as const;

const { source: _source, ...MISSING_ROOT_REQUIRED_FIELD } = POSSIBLE;
const { recoveryScore: _recoveryScore, ...METRICS_WITH_REQUIRED_KEY_MISSING } = POSSIBLE.metrics;

const INVALID_EVIDENCE = [
  { label: "camera is not back", value: { ...POSSIBLE, camera: "front" } },
  { label: "analyzer version is unknown", value: { ...POSSIBLE, analyzerVersion: "unknown" } },
  { label: "root required field missing", value: MISSING_ROOT_REQUIRED_FIELD },
  { label: "root extra field", value: { ...POSSIBLE, privatePath: "/private/source.mp4" } },
  {
    label: "metrics required key missing",
    value: { ...POSSIBLE, metrics: METRICS_WITH_REQUIRED_KEY_MISSING },
  },
  {
    label: "metrics extra key",
    value: { ...POSSIBLE, metrics: { ...POSSIBLE.metrics, confidence: 0.9 } },
  },
  { label: "possible contact has issues", value: { ...POSSIBLE, issues: ["low_visibility"] } },
  { label: "possible contact has null metrics", value: { ...POSSIBLE, metrics: null } },
  {
    label: "no impact has a candidate timestamp",
    value: { ...NO_IMPACT_SIGNAL_OBSERVED, candidateTimestampMs: 2_000 },
  },
  { label: "indeterminate has no issues", value: { ...INDETERMINATE, issues: [] } },
  {
    label: "indeterminate has metrics",
    value: { ...INDETERMINATE, metrics: POSSIBLE.metrics },
  },
  { label: "clip ID is empty", value: { ...POSSIBLE, clipId: "" } },
  { label: "clip ID starts with punctuation", value: { ...POSSIBLE, clipId: "-back-001" } },
  { label: "clip ID has 129 characters", value: { ...POSSIBLE, clipId: `a${"a".repeat(128)}` } },
  { label: "clip ID has an invalid character", value: { ...POSSIBLE, clipId: "back/001" } },
  {
    label: "metric score is Infinity",
    value: { ...POSSIBLE, metrics: { ...POSSIBLE.metrics, impulseScore: Infinity } },
  },
  {
    label: "metric score is NaN",
    value: { ...POSSIBLE, metrics: { ...POSSIBLE.metrics, impulseScore: Number.NaN } },
  },
  {
    label: "metric score is negative Infinity",
    value: { ...POSSIBLE, metrics: { ...POSSIBLE.metrics, impulseScore: -Infinity } },
  },
  {
    label: "metric score exceeds one",
    value: { ...POSSIBLE, metrics: { ...POSSIBLE.metrics, impulseScore: 1.01 } },
  },
  {
    label: "metric score is negative",
    value: { ...POSSIBLE, metrics: { ...POSSIBLE.metrics, impulseScore: -0.01 } },
  },
  { label: "candidate timestamp is negative", value: { ...POSSIBLE, candidateTimestampMs: -1 } },
  {
    label: "candidate timestamp exceeds duration",
    value: { ...POSSIBLE, candidateTimestampMs: 4_001 },
  },
  {
    label: "candidate timestamp is Infinity",
    value: { ...POSSIBLE, candidateTimestampMs: Infinity },
  },
  { label: "candidate timestamp is NaN", value: { ...POSSIBLE, candidateTimestampMs: Number.NaN } },
  {
    label: "duration is unsafe",
    value: { ...POSSIBLE, analysisDurationMs: Number.MAX_SAFE_INTEGER + 1 },
  },
  { label: "duration is negative", value: { ...POSSIBLE, analysisDurationMs: -1 } },
  { label: "duration is non-integer", value: { ...POSSIBLE, analysisDurationMs: 4_000.5 } },
  {
    label: "frame count is unsafe",
    value: { ...POSSIBLE, analyzedFrames: Number.MAX_SAFE_INTEGER + 1 },
  },
  { label: "frame count is negative", value: { ...POSSIBLE, analyzedFrames: -1 } },
  { label: "frame count is non-integer", value: { ...POSSIBLE, analyzedFrames: 32.5 } },
] as const;

describe("parseBackImpactEvidence", () => {
  it("accepts a versioned possible-contact result", () => {
    expect(parseBackImpactEvidence(POSSIBLE)).toEqual(POSSIBLE);
    expect(isBackImpactEvidence(POSSIBLE)).toBe(true);
  });

  it("accepts a no-impact-signal-observed result", () => {
    expect(parseBackImpactEvidence(NO_IMPACT_SIGNAL_OBSERVED)).toEqual(NO_IMPACT_SIGNAL_OBSERVED);
  });

  it("accepts an indeterminate result with an issue", () => {
    expect(parseBackImpactEvidence(INDETERMINATE)).toEqual(INDETERMINATE);
  });

  it.each(INVALID_EVIDENCE)("rejects $label", ({ value }) => {
    expect(isBackImpactEvidence(value)).toBe(false);
    expect(() => parseBackImpactEvidence(value)).toThrow(
      new TypeError("invalid back impact evidence"),
    );
  });
});
