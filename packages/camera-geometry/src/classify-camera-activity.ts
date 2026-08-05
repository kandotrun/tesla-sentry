import { isCameraActivityEventEvidence } from "./camera-activity-evidence";
import { classifyContactEvent } from "./classify-event";
import type { ContactEventEvidence, ContactVerdict } from "./types";

export function classifyContactEventWithCameraActivity(
  evidence: ContactEventEvidence,
  cameraActivityEvidence: unknown,
): ContactVerdict {
  const baseVerdict = classifyContactEvent(evidence);
  if (baseVerdict.verdict === "contact" || baseVerdict.verdict === "possible_contact") {
    return baseVerdict;
  }
  if (
    !isCameraActivityEventEvidence(cameraActivityEvidence) ||
    cameraActivityEvidence.status === "indeterminate"
  ) {
    return {
      reasons: ["camera_activity_analysis_unavailable"],
      verdict: "indeterminate",
    };
  }
  if (cameraActivityEvidence.status === "activity_detected") {
    return {
      reasons: ["camera_temporal_activity_signal"],
      verdict: "possible_contact",
    };
  }
  return baseVerdict;
}
