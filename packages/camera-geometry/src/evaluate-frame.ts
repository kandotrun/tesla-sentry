import { minimumDistanceToSegments, polygonIntersectsSegment, polygonsIntersect } from "./polygon";
import { profileGeometryFingerprintV1 } from "./profile-fingerprint";
import type {
  ContactCameraProfileV2,
  ContactCapableTeslaCamera,
  FrameGeometryEvaluation,
  FrameGeometryObservation,
  FrameGeometryState,
  VehicleCameraProfileV2,
} from "./types";
import { validateVehicleCameraProfileV2 } from "./validate-profile";

function isContactCapableCamera(value: unknown): value is ContactCapableTeslaCamera {
  return value === "left_repeater" || value === "right_repeater";
}

function assertValidFrameInput(
  profile: VehicleCameraProfileV2,
  observation: FrameGeometryObservation,
): ContactCameraProfileV2 {
  if (validateVehicleCameraProfileV2(profile).length > 0) {
    throw new TypeError("profile must be a valid V2 vehicle camera profile");
  }
  if (!isContactCapableCamera(observation.camera)) {
    throw new TypeError("observation camera must be contact capable");
  }
  if (
    !Number.isFinite(observation.boundaryOcclusionRatio) ||
    observation.boundaryOcclusionRatio < 0 ||
    observation.boundaryOcclusionRatio > 1
  ) {
    throw new RangeError("boundaryOcclusionRatio must be finite and between 0 and 1");
  }
  if (!Number.isFinite(observation.frameTimestampMs) || observation.frameTimestampMs < 0) {
    throw new RangeError("frameTimestampMs must be finite and non-negative");
  }
  const cameraProfile = profile.cameras.find(
    (camera) => camera.kind === "contact_geometry" && camera.camera === observation.camera,
  );
  if (cameraProfile?.kind !== "contact_geometry") {
    throw new TypeError("profile must provide matching contact geometry");
  }
  return cameraProfile;
}

function evaluateState(
  profile: ContactCameraProfileV2,
  observation: FrameGeometryObservation,
): FrameGeometryState {
  if (observation.boundaryOcclusionRatio > profile.occlusionThreshold) {
    return "occluded";
  }

  const intersectsContactBoundary = profile.contactBoundary.some((segment) =>
    polygonIntersectsSegment(observation.objectMask, segment),
  );
  const intersectsSelfVehicle = profile.selfVehicleMasks.some((mask) =>
    polygonsIntersect(observation.objectMask, mask),
  );
  if (intersectsContactBoundary || intersectsSelfVehicle) {
    return "boundary_overlap";
  }

  if (profile.nearBodyZones.some((zone) => polygonsIntersect(observation.objectMask, zone))) {
    return "near";
  }

  return "outside";
}

export function evaluateFrameGeometry(
  profile: VehicleCameraProfileV2,
  observation: FrameGeometryObservation,
): FrameGeometryEvaluation {
  const cameraProfile = assertValidFrameInput(profile, observation);
  const minimumBoundaryDistanceNormalized = minimumDistanceToSegments(
    observation.objectMask,
    cameraProfile.contactBoundary,
  );

  return {
    camera: observation.camera,
    frameTimestampMs: observation.frameTimestampMs,
    intersectsBlindZone: cameraProfile.blindZones.some((zone) =>
      polygonsIntersect(observation.objectMask, zone),
    ),
    minimumBoundaryDistanceNormalized,
    profileGeometryFingerprint: profileGeometryFingerprintV1(profile),
    profileId: profile.profileId,
    profileSchemaVersion: 2,
    source: "contact_geometry",
    state: evaluateState(cameraProfile, observation),
  };
}
