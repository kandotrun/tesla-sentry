import { isBackImpactEvidence } from "./back-impact-evidence";
import {
  evaluationMatchesProfile,
  hasMatchedProfileProvenance,
  hasValidEvaluationProfileProvenance,
} from "./profile-provenance";
import type {
  ContactCapableTeslaCamera,
  ContactCoverage,
  ContactEventEvidence,
  ContactVerdict,
  ContextCameraCoverageEvidence,
  ContextualTeslaCamera,
  DirectCameraCoverageEvidence,
  FrameGeometryEvaluation,
  IndeterminateReason,
} from "./types";

const CONTACT_CAMERAS = [
  "left_repeater",
  "right_repeater",
] as const satisfies readonly ContactCapableTeslaCamera[];

const CONTEXT_CAMERAS = [
  "front",
  "back",
  "left_pillar",
  "right_pillar",
] as const satisfies readonly ContextualTeslaCamera[];

const BOOLEAN_EVENT_FIELDS = [
  "cameraEvidenceConflict",
  "completeTrack",
  "deformationOrRebound",
  "enteredBlindZone",
  "globalShake",
  "qualityAcceptable",
  "timingReliable",
  "trackedBeforeAndAfterClosestApproach",
  "trajectoryDiscontinuity",
] as const satisfies readonly (keyof ContactEventEvidence)[];

function isContactCapableCamera(value: unknown): value is ContactCapableTeslaCamera {
  return value === "left_repeater" || value === "right_repeater";
}

function isContextualCamera(value: unknown): value is ContextualTeslaCamera {
  return (
    value === "front" || value === "back" || value === "left_pillar" || value === "right_pillar"
  );
}

function isValidContextCameraEvidence(
  evidence: unknown,
): evidence is ContextCameraCoverageEvidence {
  return (
    isRecord(evidence) &&
    isContextualCamera(evidence.camera) &&
    (evidence.state === "no_relevant_track" ||
      evidence.state === "resolved_to_direct" ||
      evidence.state === "unresolved")
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isCompleteDirectCameraObservation(
  observation: unknown,
): observation is DirectCameraCoverageEvidence {
  return (
    isRecord(observation) &&
    isContactCapableCamera(observation.camera) &&
    observation.observedBeforeClosestApproach === true &&
    observation.observedAtClosestApproach === true &&
    observation.observedAfterClosestApproach === true &&
    observation.boundaryUnobscuredAtClosestApproach === true
  );
}

function hasCompleteContactCoverage(coverage: ContactCoverage): boolean {
  if (
    !isRecord(coverage) ||
    coverage.kind !== "complete" ||
    !Array.isArray(coverage.directCameraObservations) ||
    !Array.isArray(coverage.contextCameraEvidence)
  ) {
    return false;
  }

  const observations = coverage.directCameraObservations;
  const contextEvidence = coverage.contextCameraEvidence;
  return (
    observations.length === CONTACT_CAMERAS.length &&
    observations.every(isCompleteDirectCameraObservation) &&
    new Set(observations.map((observation) => observation.camera)).size ===
      CONTACT_CAMERAS.length &&
    CONTACT_CAMERAS.every((camera) =>
      observations.some((observation) => observation.camera === camera),
    ) &&
    contextEvidence.length === CONTEXT_CAMERAS.length &&
    contextEvidence.every(isValidContextCameraEvidence) &&
    new Set(contextEvidence.map((evidence) => evidence.camera)).size === CONTEXT_CAMERAS.length &&
    CONTEXT_CAMERAS.every((camera) =>
      contextEvidence.some((evidence) => evidence.camera === camera),
    ) &&
    contextEvidence.every((evidence) => evidence.state !== "unresolved")
  );
}

function isValidEvaluation(evaluation: unknown): evaluation is FrameGeometryEvaluation {
  return (
    isRecord(evaluation) &&
    evaluation.source === "contact_geometry" &&
    isContactCapableCamera(evaluation.camera) &&
    typeof evaluation.frameTimestampMs === "number" &&
    Number.isFinite(evaluation.frameTimestampMs) &&
    evaluation.frameTimestampMs >= 0 &&
    typeof evaluation.intersectsBlindZone === "boolean" &&
    typeof evaluation.minimumBoundaryDistanceNormalized === "number" &&
    Number.isFinite(evaluation.minimumBoundaryDistanceNormalized) &&
    evaluation.minimumBoundaryDistanceNormalized >= 0 &&
    hasValidEvaluationProfileProvenance(evaluation) &&
    (evaluation.state === "boundary_overlap" ||
      evaluation.state === "near" ||
      evaluation.state === "occluded" ||
      evaluation.state === "outside")
  );
}

function isValidCorroboratingContactCamera(value: unknown): boolean {
  return value === null || isContactCapableCamera(value);
}

function eventSignalsAreValid(evidence: ContactEventEvidence): boolean {
  return BOOLEAN_EVENT_FIELDS.every((field) => typeof evidence[field] === "boolean");
}

function addReason(reasons: IndeterminateReason[], reason: IndeterminateReason): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

export function classifyContactEvent(evidence: ContactEventEvidence): ContactVerdict {
  const backImpactEvidenceIsValid = isBackImpactEvidence(evidence.backImpactEvidence);
  const backImpactAnalysisUnavailable =
    !backImpactEvidenceIsValid || evidence.backImpactEvidence.status === "indeterminate";
  const hasBackTemporalImpactSignal =
    backImpactEvidenceIsValid && evidence.backImpactEvidence.status === "possible_contact";
  const evaluations = Array.isArray(evidence.evaluations) ? evidence.evaluations : [];
  const matchedProfile = hasMatchedProfileProvenance(evidence.profileMatch)
    ? evidence.profileMatch
    : null;
  const validEvaluations = evaluations.filter(isValidEvaluation);
  const evaluationsAreValid =
    Array.isArray(evidence.evaluations) && validEvaluations.length === evaluations.length;
  const corroboratingContactCameraIsValid = isValidCorroboratingContactCamera(
    evidence.corroboratingContactCamera,
  );
  const signalsAreValid = eventSignalsAreValid(evidence);
  const hasBoundaryOverlap = validEvaluations.some(
    (evaluation) => evaluation.state === "boundary_overlap",
  );
  const hasCorroboratingContactSignal =
    corroboratingContactCameraIsValid && evidence.corroboratingContactCamera !== null;
  const hasIndependentCorroboratingContactCamera =
    hasCorroboratingContactSignal &&
    validEvaluations.some(
      (evaluation) =>
        evaluation.state === "boundary_overlap" &&
        evaluation.camera !== evidence.corroboratingContactCamera,
    );
  const hasReinforcementSignal =
    evidence.globalShake === true ||
    evidence.trajectoryDiscontinuity === true ||
    evidence.deformationOrRebound === true ||
    hasCorroboratingContactSignal;
  const hasIndependentReinforcement =
    evidence.globalShake === true ||
    evidence.trajectoryDiscontinuity === true ||
    evidence.deformationOrRebound === true ||
    hasIndependentCorroboratingContactCamera;
  const reasons: IndeterminateReason[] = [];

  if (
    matchedProfile === null ||
    !evaluations.every((evaluation) => evaluationMatchesProfile(evaluation, matchedProfile))
  ) {
    addReason(reasons, "profile_mismatch");
  }
  if (
    validEvaluations.length === 0 ||
    !evaluationsAreValid ||
    !corroboratingContactCameraIsValid ||
    !signalsAreValid ||
    !hasCompleteContactCoverage(evidence.contactCoverage)
  ) {
    addReason(reasons, "insufficient_camera_coverage");
  }
  if (validEvaluations.some((evaluation) => evaluation.state === "occluded")) {
    addReason(reasons, "boundary_occluded");
  }
  if (
    evidence.enteredBlindZone ||
    validEvaluations.some((evaluation) => evaluation.intersectsBlindZone)
  ) {
    addReason(reasons, "entered_blind_zone");
  }
  if (!evidence.completeTrack || !evidence.trackedBeforeAndAfterClosestApproach) {
    addReason(reasons, "track_lost");
  }
  if (!evidence.qualityAcceptable) {
    addReason(reasons, "low_visibility");
  }
  if (!evidence.timingReliable) {
    addReason(reasons, "timing_unreliable");
  }
  if (
    evidence.cameraEvidenceConflict ||
    (evaluationsAreValid && hasReinforcementSignal && !hasBoundaryOverlap)
  ) {
    addReason(reasons, "conflicting_evidence");
  }
  if (hasBoundaryOverlap && !hasIndependentReinforcement) {
    addReason(reasons, "insufficient_contact_evidence");
  }

  if (reasons.length === 0 && hasBoundaryOverlap && hasIndependentReinforcement) {
    return { reasons: [], verdict: "contact" };
  }
  if (hasBackTemporalImpactSignal) {
    return { reasons: ["back_temporal_impact_signal"], verdict: "possible_contact" };
  }
  if (backImpactAnalysisUnavailable) {
    return {
      reasons: ["back_impact_analysis_unavailable", ...reasons],
      verdict: "indeterminate",
    };
  }
  if (reasons.length > 0) {
    return { reasons, verdict: "indeterminate" };
  }

  return { reasons: [], verdict: "no_contact_observed" };
}
