import { profileGeometryFingerprintV1 } from "./profile-fingerprint";
import type {
  CameraProfileV2,
  CameraRecordingDescriptor,
  ProfileMatchResult,
  ProfileMismatchReason,
  VehicleCameraProfileV2,
} from "./types";
import { validateVehicleCameraProfileV2 } from "./validate-profile";

const REQUIRED_CAMERAS = [
  "front",
  "back",
  "left_repeater",
  "right_repeater",
  "left_pillar",
  "right_pillar",
] as const;

const PROFILE_MISMATCH_REASON_ORDER = [
  "invalid_profile",
  "duplicate_camera",
  "missing_required_camera",
  "unexpected_camera",
  "codec_mismatch",
  "resolution_mismatch",
  "anchor_unavailable",
  "anchor_drift",
  "rotation_mismatch",
  "cropped_input",
] as const satisfies readonly ProfileMismatchReason[];

function directAnchorMismatchReason(
  anchorErrorNormalized: number | null,
  anchorToleranceNormalized: number,
): ProfileMismatchReason | null {
  if (anchorErrorNormalized === null) {
    return "anchor_unavailable";
  }
  if (
    !Number.isFinite(anchorErrorNormalized) ||
    anchorErrorNormalized < 0 ||
    anchorErrorNormalized > anchorToleranceNormalized
  ) {
    return "anchor_drift";
  }
  return null;
}

function anchorMismatchReason(
  camera: CameraProfileV2,
  descriptor: CameraRecordingDescriptor,
  anchorToleranceNormalized: number,
): ProfileMismatchReason | null {
  switch (camera.kind) {
    case "contact_geometry":
      return directAnchorMismatchReason(
        descriptor.anchorErrorNormalized,
        anchorToleranceNormalized,
      );
    case "context_only":
      return descriptor.anchorErrorNormalized === null ? null : "anchor_drift";
  }
}

function recordingMatchesCamera(
  camera: CameraProfileV2,
  descriptor: CameraRecordingDescriptor,
  anchorToleranceNormalized: number,
): readonly ProfileMismatchReason[] {
  const reasons: ProfileMismatchReason[] = [];

  if (descriptor.codec !== camera.codec) {
    reasons.push("codec_mismatch");
  }
  if (descriptor.width !== camera.width || descriptor.height !== camera.height) {
    reasons.push("resolution_mismatch");
  }
  const anchorReason = anchorMismatchReason(camera, descriptor, anchorToleranceNormalized);
  if (anchorReason !== null) {
    reasons.push(anchorReason);
  }
  if (descriptor.rotationDegrees !== 0) {
    reasons.push("rotation_mismatch");
  }
  if (descriptor.cropped !== false) {
    reasons.push("cropped_input");
  }

  return reasons;
}

export function matchVehicleCameraProfileV2(
  profile: VehicleCameraProfileV2,
  descriptors: readonly CameraRecordingDescriptor[],
): ProfileMatchResult {
  if (validateVehicleCameraProfileV2(profile).length > 0) {
    return { kind: "mismatched", reasons: ["invalid_profile"] };
  }

  const reasons = new Set<ProfileMismatchReason>();
  const recordingCameras = new Set<CameraRecordingDescriptor["camera"]>();

  for (const descriptor of descriptors) {
    if (recordingCameras.has(descriptor.camera)) {
      reasons.add("duplicate_camera");
    }
    recordingCameras.add(descriptor.camera);
  }

  for (const requiredCamera of REQUIRED_CAMERAS) {
    if (!recordingCameras.has(requiredCamera)) {
      reasons.add("missing_required_camera");
    }
  }

  for (const descriptor of descriptors) {
    const camera = profile.cameras.find(
      (profileCamera) => profileCamera.camera === descriptor.camera,
    );
    if (!camera) {
      reasons.add("unexpected_camera");
      continue;
    }
    for (const reason of recordingMatchesCamera(
      camera,
      descriptor,
      profile.anchorToleranceNormalized,
    )) {
      reasons.add(reason);
    }
  }

  const orderedReasons = PROFILE_MISMATCH_REASON_ORDER.filter((reason) => reasons.has(reason));
  if (orderedReasons.length === 0) {
    return {
      kind: "matched",
      profileGeometryFingerprint: profileGeometryFingerprintV1(profile),
      profileId: profile.profileId,
      schemaVersion: 2,
    };
  }

  return { kind: "mismatched", reasons: orderedReasons };
}
