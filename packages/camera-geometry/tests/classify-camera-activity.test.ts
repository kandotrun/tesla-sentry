import { describe, expect, it } from "vitest";
import { classifyContactEventWithCameraActivity } from "../src/index";
import { evaluation, makeEventEvidence } from "./fixtures";

const ORDER = [
  "front",
  "back",
  "left_repeater",
  "right_repeater",
  "left_pillar",
  "right_pillar",
] as const;

function aggregate(status: "activity_detected" | "no_activity_signal_observed" | "indeterminate") {
  return {
    analyzerVersion: "camera-temporal-activity-v3",
    cameras: ORDER.map((camera) => ({
      analysisDurationMs: status === "indeterminate" && camera === "back" ? 0 : 4_000,
      analyzedFrames: status === "indeterminate" && camera === "back" ? 0 : 32,
      analyzerVersion: "camera-temporal-activity-v3",
      camera,
      candidateTimestampMs: status === "activity_detected" && camera === "back" ? 1_500 : null,
      clipId: `${camera}-001`,
      issues: status === "indeterminate" && camera === "back" ? ["decode_failed"] : [],
      metrics:
        status === "indeterminate" && camera === "back"
          ? null
          : {
              changedPixelRatio: 0.06,
              gradientChangeRatio: 0.08,
              nearCameraScore: status === "activity_detected" && camera === "back" ? 0.75 : 0.3,
              occlusionFlatRatio: status === "activity_detected" && camera === "back" ? 0.55 : 0,
              occlusionQualifyingSamples:
                status === "activity_detected" && camera === "back" ? 2 : 0,
              occlusionScore: status === "activity_detected" && camera === "back" ? 0.75 : 0,
              qualifyingSamples: status === "activity_detected" && camera === "back" ? 2 : 0,
            },
      schemaVersion: 1,
      source: "camera_temporal_activity",
      status:
        status === "activity_detected" && camera === "back"
          ? "activity_detected"
          : status === "indeterminate" && camera === "back"
            ? "indeterminate"
            : "no_activity_signal_observed",
    })),
    eventId: "event-001",
    schemaVersion: 1,
    source: "camera_temporal_activity",
    status,
  } as const;
}

describe("classifyContactEventWithCameraActivity", () => {
  it("turns any valid camera activity into possible contact only", () => {
    expect(
      classifyContactEventWithCameraActivity(makeEventEvidence(), aggregate("activity_detected")),
    ).toEqual({ reasons: ["camera_temporal_activity_signal"], verdict: "possible_contact" });
  });

  it("never downgrades valid direct repeater contact", () => {
    expect(
      classifyContactEventWithCameraActivity(
        makeEventEvidence({
          evaluations: [evaluation("boundary_overlap")],
          trajectoryDiscontinuity: true,
        }),
        aggregate("indeterminate"),
      ),
    ).toEqual({ reasons: [], verdict: "contact" });
  });

  it("preserves the base verdict when all six cameras have no signal", () => {
    expect(
      classifyContactEventWithCameraActivity(
        makeEventEvidence(),
        aggregate("no_activity_signal_observed"),
      ),
    ).toEqual({ reasons: [], verdict: "no_contact_observed" });
  });

  it("fails closed when camera activity evidence is invalid or indeterminate", () => {
    for (const activity of [
      aggregate("indeterminate"),
      { ...aggregate("activity_detected"), cameras: [] },
    ]) {
      expect(
        Reflect.apply(classifyContactEventWithCameraActivity, undefined, [
          makeEventEvidence(),
          activity,
        ]),
      ).toEqual({
        reasons: ["camera_activity_analysis_unavailable"],
        verdict: "indeterminate",
      });
    }
  });
});
