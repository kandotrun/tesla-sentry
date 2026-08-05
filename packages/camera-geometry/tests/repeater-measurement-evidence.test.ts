import { describe, expect, it } from "vitest";
import EVIDENCE from "../evidence/model-y-2025-plus-repeater-measurement-v1.json" with {
  type: "json",
};
import { MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V2 } from "../src/model-y-2025-plus";

function collectKeys(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectKeys);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const left = sorted[Math.floor((sorted.length - 1) / 2)];
  const right = sorted[Math.floor(sorted.length / 2)];
  if (left === undefined || right === undefined) {
    throw new TypeError("Cannot calculate a median without values");
  }
  return (left + right) / 2;
}

function profileAnchors(camera: "left_repeater" | "right_repeater") {
  const profile = MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V2.cameras.find(
    (candidate) => candidate.camera === camera,
  );
  if (profile?.kind !== "contact_geometry") {
    throw new TypeError(`Missing contact profile for ${camera}`);
  }
  return profile.anchors;
}

function isRepeater(camera: string): camera is "left_repeater" | "right_repeater" {
  return camera === "left_repeater" || camera === "right_repeater";
}

describe("repeater measurement evidence", () => {
  it("keeps the artifact anonymous and records the complete measurement boundary", () => {
    expect(Object.keys(EVIDENCE).sort()).toEqual([
      "backDecoded",
      "cameras",
      "humanVisibilityMachineReproducible",
      "inventory",
      "method",
      "normalization",
      "rawAnchorExtractionImplemented",
      "schemaVersion",
      "selection",
      "source",
      "thresholds",
    ]);
    expect(EVIDENCE).toMatchObject({
      backDecoded: false,
      humanVisibilityMachineReproducible: false,
      rawAnchorExtractionImplemented: false,
      schemaVersion: 1,
      selection: {
        calibrationHoldoutOverlap: 0,
        calibrationGroups: 12,
        decodedCameras: ["left_repeater", "right_repeater"],
        holdoutGroups: 12,
        relativeSeconds: [10, 30, 50],
        selectedGroups: 24,
      },
      thresholds: {
        groupTemporalMedianAnchorErrorNormalized: 0.01,
      },
    });
    expect(EVIDENCE.source.before).toEqual(EVIDENCE.source.after);
    expect(EVIDENCE.source.before).toEqual({
      mp4Count: EVIDENCE.inventory.mp4Count,
      mp4TotalBytes: EVIDENCE.inventory.mp4TotalBytes,
    });
    expect(EVIDENCE.selection.selectedGroups).toBe(
      EVIDENCE.selection.calibrationGroups + EVIDENCE.selection.holdoutGroups,
    );
    expect(EVIDENCE.selection.cohortOrdinals.calibration).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(EVIDENCE.selection.cohortOrdinals.holdout).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(EVIDENCE.cameras.map((camera) => camera.camera)).toEqual([
      "left_repeater",
      "right_repeater",
    ]);

    const audit = EVIDENCE.selection.anonymousSelectionAudit;
    expect(Object.keys(audit).sort()).toEqual([
      "auditOnly",
      "crossCohortTokenOverlap",
      "mappingRetained",
      "method",
      "reproducibleAcrossReruns",
      "scope",
      "secretRetained",
      "tokenCollisions",
      "tokenCount",
    ]);
    expect(audit).toMatchObject({
      auditOnly: true,
      crossCohortTokenOverlap: 0,
      mappingRetained: false,
      method: "HMAC-SHA256",
      reproducibleAcrossReruns: false,
      scope: "single_authorized_measurement_run",
      secretRetained: false,
      tokenCollisions: 0,
      tokenCount: 24,
    });
    expect(audit.tokenCount).toBe(EVIDENCE.selection.selectedGroups);
    expect(EVIDENCE.selection.calibrationHoldoutOverlap).toBe(audit.crossCohortTokenOverlap);

    const forbiddenKey =
      /(?:file(?:name)?|path|capture|timestamp|sourceOrdinal|frame|hash|identifier|salt)/i;
    expect(collectKeys(EVIDENCE).filter((key) => forbiddenKey.test(key))).toEqual([]);
  });

  it("recomputes every group-median maximum, median, pass count, and profile coordinate", () => {
    const threshold = EVIDENCE.thresholds.groupTemporalMedianAnchorErrorNormalized;

    for (const camera of EVIDENCE.cameras) {
      if (!isRepeater(camera.camera)) {
        throw new TypeError(`Unexpected evidence camera ${camera.camera}`);
      }
      const anchors = profileAnchors(camera.camera);
      expect(camera.anchors).toHaveLength(2);

      for (const [index, anchor] of camera.anchors.entries()) {
        const profileAnchor = anchors[index];
        if (profileAnchor === undefined) {
          throw new TypeError(`Missing profile anchor ${index}`);
        }

        expect(anchor.normalizedPoint.x.toFixed(6)).toBe(profileAnchor.x.toFixed(6));
        expect(anchor.normalizedPoint.y.toFixed(6)).toBe(profileAnchor.y.toFixed(6));

        for (const cohort of [anchor.calibration, anchor.holdout]) {
          expect(cohort.groupTemporalMedianErrorsNormalized).toHaveLength(12);
          expect(cohort.maxErrorNormalized).toBe(
            Math.max(...cohort.groupTemporalMedianErrorsNormalized),
          );
          expect(cohort.passCount).toBe(
            cohort.groupTemporalMedianErrorsNormalized.filter((error) => error <= threshold).length,
          );
          expect(cohort.passCount).toBe(12);
        }

        expect(anchor.calibration.medianErrorNormalized).toBe(
          median(anchor.calibration.groupTemporalMedianErrorsNormalized),
        );
        expect(anchor.holdout.medianErrorNormalized).toBe(
          median(anchor.holdout.groupTemporalMedianErrorsNormalized),
        );
      }
    }
  });

  it("recomputes every individual-timepoint diagnostic and locates the holdout misses", () => {
    const threshold = EVIDENCE.thresholds.groupTemporalMedianAnchorErrorNormalized;

    for (const camera of EVIDENCE.cameras) {
      for (const anchor of camera.anchors) {
        for (const [cohortName, cohort] of [
          ["calibration", anchor.timepointMatcher.calibration],
          ["holdout", anchor.timepointMatcher.holdout],
        ] as const) {
          const auditCohort = EVIDENCE.selection.cohortOrdinals[cohortName];
          const errors = cohort.observations.flatMap((observation) =>
            observation.timepoints.map(({ errorNormalized }) => errorNormalized),
          );

          expect(cohort.observations.map(({ ordinal }) => ordinal)).toEqual(auditCohort);
          expect(
            cohort.observations.every((observation) =>
              observation.timepoints.every(
                ({ relativeSecond }, index) =>
                  relativeSecond === EVIDENCE.selection.relativeSeconds[index],
              ),
            ),
          ).toBe(true);
          expect(errors).toHaveLength(36);
          expect(cohort.total).toBe(errors.length);
          expect(cohort.passCount).toBe(errors.filter((error) => error <= threshold).length);
          expect(cohort.maxErrorNormalized).toBe(Math.max(...errors));
          expect(cohort.allAtOrBelowThreshold).toBe(errors.every((error) => error <= threshold));
        }
      }
    }

    const holdoutMisses = EVIDENCE.cameras.flatMap((camera) =>
      camera.anchors.flatMap((anchor) =>
        anchor.timepointMatcher.holdout.observations.flatMap((observation) =>
          observation.timepoints
            .filter(({ errorNormalized }) => errorNormalized > threshold)
            .map(({ errorNormalized, relativeSecond }) => ({
              anchorId: anchor.id,
              camera: camera.camera,
              errorNormalized,
              ordinal: observation.ordinal,
              relativeSecond,
            })),
        ),
      ),
    );
    expect(holdoutMisses).toEqual([
      {
        anchorId: "A",
        camera: "left_repeater",
        errorNormalized: 0.013331266,
        ordinal: 1,
        relativeSecond: 10,
      },
      {
        anchorId: "A",
        camera: "right_repeater",
        errorNormalized: 0.013910886,
        ordinal: 4,
        relativeSecond: 50,
      },
      {
        anchorId: "B",
        camera: "right_repeater",
        errorNormalized: 0.013331266,
        ordinal: 8,
        relativeSecond: 10,
      },
    ]);
  });
});
