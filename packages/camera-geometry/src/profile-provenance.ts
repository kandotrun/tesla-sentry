import type { ProfileMatchResult } from "./types";

const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROFILE_GEOMETRY_FINGERPRINT = /^sha256-v1:[0-9a-f]{64}$/;

export type MatchedProfile = Extract<ProfileMatchResult, { readonly kind: "matched" }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function hasValidEvaluationProfileProvenance(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.profileGeometryFingerprint === "string" &&
    PROFILE_GEOMETRY_FINGERPRINT.test(value.profileGeometryFingerprint) &&
    typeof value.profileId === "string" &&
    SAFE_PROFILE_ID.test(value.profileId) &&
    value.profileSchemaVersion === 2
  );
}

export function hasMatchedProfileProvenance(value: unknown): value is MatchedProfile {
  return (
    isRecord(value) &&
    value.kind === "matched" &&
    value.schemaVersion === 2 &&
    typeof value.profileId === "string" &&
    SAFE_PROFILE_ID.test(value.profileId) &&
    typeof value.profileGeometryFingerprint === "string" &&
    PROFILE_GEOMETRY_FINGERPRINT.test(value.profileGeometryFingerprint)
  );
}

export function evaluationMatchesProfile(
  evaluation: unknown,
  profileMatch: MatchedProfile,
): boolean {
  return (
    isRecord(evaluation) &&
    evaluation.profileId === profileMatch.profileId &&
    evaluation.profileSchemaVersion === profileMatch.schemaVersion &&
    evaluation.profileGeometryFingerprint === profileMatch.profileGeometryFingerprint
  );
}
