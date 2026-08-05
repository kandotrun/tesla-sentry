import type { KnownTeslaCamera } from "@sentry-check/teslacam-parser";
import { matchVehicleCameraProfileV2 } from "../src/match-profile";
import type {
  BackImpactEvidence,
  CameraProfileV2,
  CameraRecordingDescriptor,
  ContactCameraProfileV2,
  ContactCapableTeslaCamera,
  ContactCoverage,
  ContactEventEvidence,
  ContextCameraCoverageEvidence,
  ContextCameraProfileV2,
  ContextualTeslaCamera,
  DirectCameraCoverageEvidence,
  FrameGeometryEvaluation,
  FrameGeometryObservation,
  FrameGeometryState,
  NormalizedPoint,
  NormalizedPolygon,
  VehicleCameraProfileV2,
} from "../src/types";

export const CONTACT_CAMERAS = [
  "left_repeater",
  "right_repeater",
] as const satisfies readonly ContactCapableTeslaCamera[];

export const CONTEXT_CAMERAS = [
  "front",
  "back",
  "left_pillar",
  "right_pillar",
] as const satisfies readonly ContextualTeslaCamera[];

export const KNOWN_CAMERAS = [
  "front",
  "back",
  "left_repeater",
  "right_repeater",
  "left_pillar",
  "right_pillar",
] as const satisfies readonly KnownTeslaCamera[];

export function backImpactEvidence(
  status: "possible_contact" | "no_impact_signal_observed" = "no_impact_signal_observed",
): BackImpactEvidence {
  const base = {
    analysisDurationMs: 4_000,
    analyzedFrames: 32,
    analyzerVersion: "back-temporal-impact-v1" as const,
    camera: "back" as const,
    clipId: "back-001",
    issues: [] as const,
    schemaVersion: 1 as const,
    source: "back_temporal_motion" as const,
  };

  if (status === "possible_contact") {
    return {
      ...base,
      candidateTimestampMs: 2_000,
      metrics: {
        globalMotionScore: 0.72,
        impulseScore: 0.64,
        recoveryScore: 0.59,
      },
      status,
    };
  }

  return {
    ...base,
    candidateTimestampMs: null,
    metrics: {
      globalMotionScore: 0.08,
      impulseScore: 0.05,
      recoveryScore: 0.04,
    },
    status,
  };
}

export function directCameraCoverageEvidence(
  camera: ContactCapableTeslaCamera,
  overrides: Partial<Omit<DirectCameraCoverageEvidence, "camera">> = {},
): DirectCameraCoverageEvidence {
  return {
    boundaryUnobscuredAtClosestApproach: true,
    camera,
    observedAfterClosestApproach: true,
    observedAtClosestApproach: true,
    observedBeforeClosestApproach: true,
    ...overrides,
  };
}

export function contextCameraCoverageEvidence(
  camera: ContextualTeslaCamera,
  state: ContextCameraCoverageEvidence["state"] = "no_relevant_track",
): ContextCameraCoverageEvidence {
  return { camera, state };
}

export const COMPLETE_UPSTREAM_OBSERVATION_COVERAGE = {
  contextCameraEvidence: CONTEXT_CAMERAS.map((camera) => contextCameraCoverageEvidence(camera)),
  directCameraObservations: CONTACT_CAMERAS.map((camera) => directCameraCoverageEvidence(camera)),
  kind: "complete",
} as const satisfies ContactCoverage;

export function point(x: number, y: number): NormalizedPoint {
  return { x, y };
}

export function polygon(...points: readonly NormalizedPoint[]): NormalizedPolygon {
  return points;
}

export function square(x: number, y: number, size: number): NormalizedPolygon {
  return polygon(point(x, y), point(x + size, y), point(x + size, y + size), point(x, y + size));
}

type ContactCameraOverrides = Partial<Omit<ContactCameraProfileV2, "camera" | "kind">>;

export function makeContactCamera(
  camera: ContactCapableTeslaCamera,
  overrides: ContactCameraOverrides = {},
): ContactCameraProfileV2 {
  const body = polygon(point(0.4, 0.4), point(0.6, 0.4), point(0.6, 0.6), point(0.4, 0.6));
  return {
    anchors: [point(0.4, 0.4), point(0.6, 0.6)],
    blindZones: [polygon(point(0.8, 0.8), point(0.95, 0.8), point(0.95, 0.95))],
    camera,
    codec: "h264",
    contactBoundary: [
      { from: point(0.4, 0.4), to: point(0.6, 0.4) },
      { from: point(0.6, 0.4), to: point(0.6, 0.6) },
    ],
    height: 938,
    kind: "contact_geometry",
    nearBodyZones: [polygon(point(0.3, 0.3), point(0.7, 0.3), point(0.7, 0.7), point(0.3, 0.7))],
    occlusionThreshold: 0.05,
    pairedCameras:
      camera === "left_repeater"
        ? ["front", "back", "left_pillar"]
        : ["front", "back", "right_pillar"],
    selfVehicleMasks: [body],
    width: 1448,
    ...overrides,
  };
}

export function makeContextCamera(camera: ContextualTeslaCamera): ContextCameraProfileV2 {
  const base = {
    codec: "h264" as const,
    height: camera === "front" ? 1876 : 938,
    kind: "context_only" as const,
    pairedCameras:
      camera === "front" || camera === "back"
        ? (["left_repeater", "right_repeater"] as const)
        : camera === "left_pillar"
          ? (["left_repeater"] as const)
          : (["right_repeater"] as const),
    width: camera === "front" ? 2896 : 1448,
  };
  if (camera === "back") {
    return {
      ...base,
      camera,
      directContactGeometry: "unvalidated",
    };
  }
  return {
    ...base,
    camera,
    directContactGeometry: "unobservable",
  };
}

export function makeGeometryCamera(): ContactCameraProfileV2 {
  return makeContactCamera("left_repeater");
}

interface ObservationOverrides {
  readonly boundaryOcclusionRatio?: number;
  readonly camera?: ContactCapableTeslaCamera;
}

export function observation(
  objectMask: NormalizedPolygon,
  overrides: ObservationOverrides = {},
): FrameGeometryObservation {
  return {
    boundaryOcclusionRatio: overrides.boundaryOcclusionRatio ?? 0,
    camera: overrides.camera ?? "left_repeater",
    frameTimestampMs: 1_000,
    objectMask,
  };
}

interface ProfileOverrides {
  readonly cameras?: readonly CameraProfileV2[];
  readonly requiredCameras?: readonly KnownTeslaCamera[];
  readonly requiredContactCameras?: readonly ContactCapableTeslaCamera[];
}

export function makeProfile(overrides: ProfileOverrides = {}): VehicleCameraProfileV2 {
  return {
    anchorToleranceNormalized: 0.01,
    cameras: overrides.cameras ?? [
      makeContextCamera("front"),
      makeContextCamera("back"),
      makeContactCamera("left_repeater"),
      makeContactCamera("right_repeater"),
      makeContextCamera("left_pillar"),
      makeContextCamera("right_pillar"),
    ],
    profileId: "synthetic-profile-v2",
    requiredCameras: overrides.requiredCameras ?? KNOWN_CAMERAS,
    requiredContactCameras: overrides.requiredContactCameras ?? CONTACT_CAMERAS,
    schemaVersion: 2,
    vehicleFamily: "model_y_2025_plus_long_range",
  };
}

function makeProfileWithLeftRepeaterCamera(
  leftRepeater: ContactCameraProfileV2,
): VehicleCameraProfileV2 {
  return makeProfile({
    cameras: makeProfile().cameras.map((camera) =>
      camera.camera === "left_repeater" ? leftRepeater : camera,
    ),
  });
}

export function makeProfileWithLeftRepeaterPairing(pairedCameras: unknown): VehicleCameraProfileV2 {
  const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
  Reflect.set(leftRepeater, "pairedCameras", pairedCameras);
  return makeProfileWithLeftRepeaterCamera(leftRepeater);
}

export function makeProfileWithoutLeftRepeaterPairing(): VehicleCameraProfileV2 {
  const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
  Reflect.deleteProperty(leftRepeater, "pairedCameras");
  return makeProfileWithLeftRepeaterCamera(leftRepeater);
}

export function recordingDescriptors(): readonly CameraRecordingDescriptor[] {
  return makeProfile().cameras.map((camera) => ({
    anchorErrorNormalized: camera.kind === "contact_geometry" ? 0.005 : null,
    camera: camera.camera,
    codec: camera.codec,
    cropped: false,
    height: camera.height,
    rotationDegrees: 0,
    width: camera.width,
  }));
}

function matchedSyntheticProfile() {
  const result = matchVehicleCameraProfileV2(makeProfile(), recordingDescriptors());
  if (result.kind !== "matched") {
    throw new TypeError("synthetic profile must match its recording descriptors");
  }
  return result;
}

export const SYNTHETIC_PROFILE_MATCH = matchedSyntheticProfile();

export function evaluation(state: FrameGeometryState): FrameGeometryEvaluation {
  return {
    camera: "left_repeater",
    frameTimestampMs: 1_000,
    intersectsBlindZone: false,
    minimumBoundaryDistanceNormalized: state === "boundary_overlap" ? 0 : 0.1,
    profileGeometryFingerprint: SYNTHETIC_PROFILE_MATCH.profileGeometryFingerprint,
    profileId: SYNTHETIC_PROFILE_MATCH.profileId,
    profileSchemaVersion: SYNTHETIC_PROFILE_MATCH.schemaVersion,
    source: "contact_geometry",
    state,
  };
}

type EvidenceOverrides = Partial<ContactEventEvidence>;

export function makeEventEvidence(overrides: EvidenceOverrides = {}): ContactEventEvidence {
  return {
    backImpactEvidence: backImpactEvidence(),
    cameraEvidenceConflict: false,
    completeTrack: true,
    contactCoverage: COMPLETE_UPSTREAM_OBSERVATION_COVERAGE,
    corroboratingContactCamera: null,
    deformationOrRebound: false,
    enteredBlindZone: false,
    evaluations: [evaluation("outside")],
    globalShake: false,
    profileMatch: SYNTHETIC_PROFILE_MATCH,
    qualityAcceptable: true,
    timingReliable: true,
    trackedBeforeAndAfterClosestApproach: true,
    trajectoryDiscontinuity: false,
    ...overrides,
  };
}
