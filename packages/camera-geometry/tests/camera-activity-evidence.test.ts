import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type CameraActivityCamera,
  isCameraActivityEvidence,
  parseCameraActivityEvidence,
} from "../src/index";

const ORDER = [
  "front",
  "back",
  "left_repeater",
  "right_repeater",
  "left_pillar",
  "right_pillar",
] as const satisfies readonly CameraActivityCamera[];

function direction(camera: CameraActivityCamera, status = "no_activity_signal_observed") {
  return {
    analysisDurationMs: 4_000,
    analyzedFrames: 32,
    analyzerVersion: "camera-temporal-activity-v2",
    camera,
    candidateTimestampMs: status === "activity_detected" ? 1_500 : null,
    clipId: `${camera}-001`,
    issues: status === "indeterminate" ? ["decode_failed"] : [],
    metrics:
      status === "indeterminate"
        ? null
        : {
            changedPixelRatio: 0.06,
            gradientChangeRatio: 0.08,
            nearCameraScore: status === "activity_detected" ? 0.75 : 0.3,
            occlusionFlatRatio: status === "activity_detected" ? 0.55 : 0,
            occlusionQualifyingSamples: status === "activity_detected" ? 2 : 0,
            occlusionScore: status === "activity_detected" ? 0.75 : 0,
            qualifyingSamples: status === "activity_detected" ? 2 : 0,
          },
    schemaVersion: 1,
    source: "camera_temporal_activity",
    status,
  };
}

function event(status = "no_activity_signal_observed") {
  return {
    analyzerVersion: "camera-temporal-activity-v2",
    cameras: ORDER.map((camera) =>
      direction(
        camera,
        camera === "front" && status === "activity_detected"
          ? "activity_detected"
          : camera === "back" && status === "indeterminate"
            ? "indeterminate"
            : "no_activity_signal_observed",
      ),
    ),
    eventId: "event-001",
    schemaVersion: 1,
    source: "camera_temporal_activity",
    status,
  };
}

describe("parseCameraActivityEvidence", () => {
  it("accepts the exact Python cross-language fixture", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/camera-temporal-activity-v2.json", import.meta.url), "utf8"),
    );

    expect(parseCameraActivityEvidence(fixture)).toEqual(fixture);
  });

  it.each(["activity_detected", "no_activity_signal_observed", "indeterminate"])(
    "accepts a strict %s direction result",
    (status) => {
      expect(parseCameraActivityEvidence(direction("back", status))).toEqual(
        direction("back", status),
      );
    },
  );

  it.each(["activity_detected", "no_activity_signal_observed", "indeterminate"])(
    "accepts a strict %s aggregate result",
    (status) => {
      expect(parseCameraActivityEvidence(event(status))).toEqual(event(status));
    },
  );

  it("rejects wrong camera order, duplicates, missing cameras, sparse arrays, and extra keys", () => {
    const valid = event();
    const sparse = [...valid.cameras];
    delete sparse[2];
    const invalid = [
      { ...valid, cameras: [valid.cameras[1], valid.cameras[0], ...valid.cameras.slice(2)] },
      { ...valid, cameras: [...valid.cameras.slice(0, 5), valid.cameras[4]] },
      { ...valid, cameras: valid.cameras.slice(0, 5) },
      { ...valid, cameras: sparse },
      { ...valid, privatePath: "/private/source.mp4" },
      { ...valid, eventId: "../private" },
    ];
    for (const value of invalid) {
      expect(isCameraActivityEvidence(value)).toBe(false);
      expect(() => parseCameraActivityEvidence(value)).toThrow(
        new TypeError("invalid camera activity evidence"),
      );
    }
  });

  it("rejects malformed metrics, timestamps, issues, and aggregate status", () => {
    const active = direction("front", "activity_detected");
    const invalid = [
      { ...active, metrics: { ...active.metrics, nearCameraScore: Number.NaN } },
      { ...active, metrics: { ...active.metrics, qualifyingSamples: -1 } },
      { ...active, metrics: { ...active.metrics, occlusionFlatRatio: Number.NaN } },
      { ...active, metrics: { ...active.metrics, occlusionScore: 1.2 } },
      { ...active, metrics: { ...active.metrics, occlusionQualifyingSamples: -1 } },
      { ...active, candidateTimestampMs: 4_001 },
      { ...active, issues: ["low_visibility"] },
      { ...active, metrics: null },
      { ...event("activity_detected"), status: "no_activity_signal_observed" },
    ];
    for (const value of invalid) {
      expect(isCameraActivityEvidence(value)).toBe(false);
    }
  });
});
