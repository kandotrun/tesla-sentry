import { describe, expect, it } from "vitest";
import type {
  CameraRecordingDescriptor,
  ContactCapableTeslaCamera,
  ContactCoverage,
  ContactEventEvidence,
  ContextCameraProfileV2,
  ContextualTeslaCamera,
  FrameGeometryEvaluation,
  FrameGeometryObservation,
  NormalizedPolygon,
} from "../src/index";
import {
  classifyContactEvent,
  evaluateFrameGeometry,
  MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V2,
  matchVehicleCameraProfileV2,
} from "../src/index";
import { backImpactEvidence } from "./fixtures";

const PROFILE = MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V2;
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

function contextCamera(camera: ContextualTeslaCamera): ContextCameraProfileV2 {
  const result = PROFILE.cameras.find(
    (profileCamera) => profileCamera.kind === "context_only" && profileCamera.camera === camera,
  );
  if (result?.kind !== "context_only") {
    throw new TypeError(`Missing context camera: ${camera}`);
  }
  return result;
}

function recordingDescriptors(): readonly CameraRecordingDescriptor[] {
  return PROFILE.cameras.map((camera) => ({
    anchorErrorNormalized: camera.kind === "contact_geometry" ? 0.005 : null,
    camera: camera.camera,
    codec: camera.codec,
    cropped: false,
    height: camera.height,
    rotationDegrees: 0,
    width: camera.width,
  }));
}

function directCoverage(camera: ContactCapableTeslaCamera) {
  return {
    boundaryUnobscuredAtClosestApproach: true,
    camera,
    observedAfterClosestApproach: true,
    observedAtClosestApproach: true,
    observedBeforeClosestApproach: true,
  } as const;
}

function contextCoverage(
  unresolvedCamera: ContextualTeslaCamera | null = null,
): Extract<ContactCoverage, { readonly kind: "complete" }> {
  return {
    contextCameraEvidence: CONTEXT_CAMERAS.map((camera) => ({
      camera,
      state: camera === unresolvedCamera ? "unresolved" : "resolved_to_direct",
    })),
    directCameraObservations: CONTACT_CAMERAS.map(directCoverage),
    kind: "complete",
  };
}

function missingRepeaterCoverage(
  missingCamera: ContactCapableTeslaCamera,
): Extract<ContactCoverage, { readonly kind: "incomplete" }> {
  return {
    contextCameraEvidence: CONTEXT_CAMERAS.map((camera) => ({
      camera,
      state: "resolved_to_direct" as const,
    })),
    directCameraObservations: CONTACT_CAMERAS.filter((camera) => camera !== missingCamera).map(
      directCoverage,
    ),
    kind: "incomplete",
    missingContactCameras: [missingCamera],
  };
}

function contextOnlyCoverage(
  camera: ContextualTeslaCamera,
): Extract<ContactCoverage, { readonly kind: "incomplete" }> {
  return {
    contextCameraEvidence: [{ camera, state: "unresolved" }],
    directCameraObservations: [],
    kind: "incomplete",
    missingContactCameras: CONTACT_CAMERAS,
  };
}

function point(x: number, y: number): { readonly x: number; readonly y: number } {
  return { x, y };
}

function rectangle(left: number, top: number, right: number, bottom: number): NormalizedPolygon {
  return [point(left, top), point(right, top), point(right, bottom), point(left, bottom)];
}

function observation(
  camera: ContactCapableTeslaCamera,
  objectMask: NormalizedPolygon,
): FrameGeometryObservation {
  return {
    boundaryOcclusionRatio: 0,
    camera,
    frameTimestampMs: 1_000,
    objectMask,
  };
}

function boundaryOverlap(camera: ContactCapableTeslaCamera): FrameGeometryEvaluation {
  const objectMask =
    camera === "left_repeater"
      ? rectangle(0.04, 0.7, 0.06, 0.72)
      : rectangle(0.94, 0.7, 0.96, 0.72);
  return evaluateFrameGeometry(PROFILE, observation(camera, objectMask));
}

function clearOfBoundary(camera: ContactCapableTeslaCamera): FrameGeometryEvaluation {
  return evaluateFrameGeometry(PROFILE, observation(camera, rectangle(0.4, 0.4, 0.42, 0.42)));
}

function eventEvidence(overrides: Partial<ContactEventEvidence> = {}): ContactEventEvidence {
  return {
    backImpactEvidence: backImpactEvidence(),
    cameraEvidenceConflict: false,
    completeTrack: true,
    contactCoverage: contextCoverage(),
    corroboratingContactCamera: null,
    deformationOrRebound: false,
    enteredBlindZone: false,
    evaluations: [clearOfBoundary("left_repeater")],
    globalShake: false,
    profileMatch: matchVehicleCameraProfileV2(PROFILE, recordingDescriptors()),
    qualityAcceptable: true,
    timingReliable: true,
    trackedBeforeAndAfterClosestApproach: true,
    trajectoryDiscontinuity: false,
    ...overrides,
  };
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  return null;
}

describe("camera geometry public consumer surface", () => {
  it("classifies measured repeater overlap with independent reinforcement as contact", () => {
    expect(
      classifyContactEvent(
        eventEvidence({
          evaluations: [boundaryOverlap("left_repeater")],
          globalShake: true,
        }),
      ),
    ).toEqual({ reasons: [], verdict: "contact" });
  });

  it("classifies a fully resolved candidate clear of the measured repeaters as no contact observed", () => {
    expect(
      classifyContactEvent(
        eventEvidence({
          evaluations: [clearOfBoundary("left_repeater"), clearOfBoundary("right_repeater")],
        }),
      ),
    ).toEqual({ reasons: [], verdict: "no_contact_observed" });
  });

  it("exposes a possible-contact verdict for a valid back signal", () => {
    expect(
      classifyContactEvent(
        eventEvidence({
          backImpactEvidence: backImpactEvidence("possible_contact"),
          contactCoverage: contextOnlyCoverage("back"),
          evaluations: [],
        }),
      ),
    ).toEqual({ reasons: ["back_temporal_impact_signal"], verdict: "possible_contact" });
  });

  it.each(CONTEXT_CAMERAS)("keeps a %s-only candidate indeterminate", (camera) => {
    expect(
      classifyContactEvent(
        eventEvidence({
          contactCoverage: contextOnlyCoverage(camera),
          evaluations: [],
        }),
      ),
    ).toEqual({ reasons: ["insufficient_camera_coverage"], verdict: "indeterminate" });
  });

  it.each(CONTACT_CAMERAS)("keeps missing %s coverage indeterminate", (camera) => {
    expect(
      classifyContactEvent(
        eventEvidence({
          contactCoverage: missingRepeaterCoverage(camera),
        }),
      ),
    ).toEqual({ reasons: ["insufficient_camera_coverage"], verdict: "indeterminate" });
  });

  it.each(CONTEXT_CAMERAS)("keeps unresolved %s context indeterminate", (camera) => {
    expect(
      classifyContactEvent(
        eventEvidence({
          contactCoverage: contextCoverage(camera),
        }),
      ),
    ).toEqual({ reasons: ["insufficient_camera_coverage"], verdict: "indeterminate" });
  });

  it.each(CONTEXT_CAMERAS)("rejects runtime geometry evaluation for %s context", (camera) => {
    const error = captureError(() =>
      Reflect.apply(evaluateFrameGeometry, undefined, [
        contextCamera(camera),
        observation("left_repeater", rectangle(0.04, 0.65, 0.05, 0.67)),
      ]),
    );

    expect(error).toEqual(new TypeError("profile must be a valid V2 vehicle camera profile"));
  });
});
