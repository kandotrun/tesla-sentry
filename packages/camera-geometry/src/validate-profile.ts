import {
  arrayHasNoHoles,
  directGeometryCoordinatesAreNormalized,
  directGeometryPolygonsAreValid,
  hasInspectableDirectGeometry,
  type InspectableCameraProfile,
  type InspectableContactCameraProfile,
  type InspectableContextCameraProfile,
  isInspectableContactCameraProfile,
  isInspectableContextCameraProfile,
  isInspectableVehicleCameraProfile,
  isNormalizedValue,
} from "./profile-shape";
import type {
  ContactCapableTeslaCamera,
  ContextualTeslaCamera,
  ProfileValidationIssue,
  ProfileValidationIssueCode,
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

const REQUIRED_CAMERAS = [...CONTACT_CAMERAS, ...CONTEXT_CAMERAS] as const;

const DIRECT_GEOMETRY_FIELDS = [
  "anchors",
  "blindZones",
  "contactBoundary",
  "nearBodyZones",
  "occlusionThreshold",
  "selfVehicleMasks",
] as const;

const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isContactCapableCamera(value: unknown): value is ContactCapableTeslaCamera {
  return value === "left_repeater" || value === "right_repeater";
}

function isContextualCamera(value: unknown): value is ContextualTeslaCamera {
  return (
    value === "front" || value === "back" || value === "left_pillar" || value === "right_pillar"
  );
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function hasExactMembers(actual: readonly unknown[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((item) => actual.includes(item))
  );
}

function contextPairingIsValid(camera: InspectableContextCameraProfile): boolean {
  return (
    Array.isArray(camera.pairedCameras) &&
    camera.pairedCameras.length > 0 &&
    arrayHasNoHoles(camera.pairedCameras) &&
    new Set(camera.pairedCameras).size === camera.pairedCameras.length &&
    camera.pairedCameras.every(isContactCapableCamera)
  );
}

function contactPairingIsValid(camera: InspectableContactCameraProfile): boolean {
  return (
    arrayHasNoHoles(camera.pairedCameras) &&
    new Set(camera.pairedCameras).size === camera.pairedCameras.length &&
    !camera.pairedCameras.some((pairedCamera) => pairedCamera === camera.camera)
  );
}

function contextHasDirectGeometry(camera: InspectableContextCameraProfile): boolean {
  const directContactGeometryIsValid =
    camera.camera === "back"
      ? camera.directContactGeometry === "unvalidated"
      : camera.directContactGeometry === "unobservable";
  return !directContactGeometryIsValid || DIRECT_GEOMETRY_FIELDS.some((field) => field in camera);
}

function addIssue(
  issues: ProfileValidationIssue[],
  code: ProfileValidationIssueCode,
  camera: ProfileValidationIssue["camera"],
): void {
  if (!issues.some((issue) => issue.code === code && issue.camera === camera)) {
    issues.push({ camera, code });
  }
}

function issueCamera(camera: unknown): ProfileValidationIssue["camera"] {
  if (isContactCapableCamera(camera) || isContextualCamera(camera)) {
    return camera;
  }
  return null;
}

function cameraRoleIsValid(camera: InspectableCameraProfile): boolean {
  switch (camera.kind) {
    case "contact_geometry":
      return isContactCapableCamera(camera.camera);
    case "context_only":
      return isContextualCamera(camera.camera);
    default:
      return false;
  }
}

function profileIdentityIsValid(profileId: unknown, vehicleFamily: unknown): boolean {
  return (
    typeof profileId === "string" &&
    SAFE_PROFILE_ID.test(profileId) &&
    vehicleFamily === "model_y_2025_plus_long_range"
  );
}

export function validateVehicleCameraProfileV2(
  profile: unknown,
): readonly ProfileValidationIssue[] {
  if (!isInspectableVehicleCameraProfile(profile)) {
    return [{ camera: null, code: "invalid_profile_shape" }];
  }

  const issues: ProfileValidationIssue[] = [];
  const cameras = new Set<unknown>();
  const contactProfiles = profile.cameras.filter(isInspectableContactCameraProfile);
  const contextProfiles = profile.cameras.filter(isInspectableContextCameraProfile);

  if (profile.schemaVersion !== 2) {
    addIssue(issues, "invalid_schema_version", null);
  }
  if (!profileIdentityIsValid(profile.profileId, profile.vehicleFamily)) {
    addIssue(issues, "invalid_profile_identity", null);
  }

  for (const profileCamera of profile.cameras) {
    if (profileCamera.codec !== "h264") {
      addIssue(issues, "invalid_codec", issueCamera(profileCamera.camera));
    }
  }

  for (const profileCamera of profile.cameras) {
    if (cameras.has(profileCamera.camera)) {
      addIssue(issues, "duplicate_camera", issueCamera(profileCamera.camera));
    }
    cameras.add(profileCamera.camera);
  }

  for (const requiredCamera of REQUIRED_CAMERAS) {
    if (!cameras.has(requiredCamera)) {
      addIssue(issues, "missing_required_camera", requiredCamera);
    }
  }

  for (const profileCamera of profile.cameras) {
    if (!cameraRoleIsValid(profileCamera)) {
      addIssue(issues, "invalid_camera_role", issueCamera(profileCamera.camera));
    }
  }

  for (const profileCamera of contactProfiles) {
    if (!hasInspectableDirectGeometry(profileCamera)) {
      addIssue(issues, "invalid_direct_geometry", issueCamera(profileCamera.camera));
    }
  }

  for (const profileCamera of contactProfiles) {
    if (
      !Array.isArray(profileCamera.anchors) ||
      profileCamera.anchors.length < 2 ||
      !arrayHasNoHoles(profileCamera.anchors)
    ) {
      addIssue(issues, "invalid_anchor_count", issueCamera(profileCamera.camera));
    }
  }

  for (const profileCamera of contactProfiles) {
    if (!contactPairingIsValid(profileCamera)) {
      addIssue(issues, "invalid_contact_pairing", issueCamera(profileCamera.camera));
    }
  }

  for (const profileCamera of contextProfiles) {
    if (contextHasDirectGeometry(profileCamera)) {
      addIssue(issues, "invalid_direct_geometry", issueCamera(profileCamera.camera));
    }
    if (!contextPairingIsValid(profileCamera)) {
      addIssue(issues, "invalid_context_pairing", issueCamera(profileCamera.camera));
    }
  }

  if (!hasExactMembers(profile.requiredCameras, REQUIRED_CAMERAS)) {
    addIssue(issues, "invalid_required_camera_set", null);
  }
  if (!hasExactMembers(profile.requiredContactCameras, CONTACT_CAMERAS)) {
    addIssue(issues, "invalid_required_contact_camera_set", null);
  }

  for (const profileCamera of profile.cameras) {
    if (!isPositiveInteger(profileCamera.width) || !isPositiveInteger(profileCamera.height)) {
      addIssue(issues, "invalid_resolution", issueCamera(profileCamera.camera));
    }
  }

  if (!isNormalizedValue(profile.anchorToleranceNormalized)) {
    addIssue(issues, "invalid_anchor_tolerance", null);
  }

  for (const profileCamera of contactProfiles) {
    if (!isNormalizedValue(profileCamera.occlusionThreshold)) {
      addIssue(issues, "invalid_occlusion_threshold", issueCamera(profileCamera.camera));
    }
  }

  for (const profileCamera of contactProfiles) {
    if (
      hasInspectableDirectGeometry(profileCamera) &&
      !directGeometryPolygonsAreValid(profileCamera)
    ) {
      addIssue(issues, "invalid_polygon", issueCamera(profileCamera.camera));
    }
  }

  for (const profileCamera of contactProfiles) {
    if (
      hasInspectableDirectGeometry(profileCamera) &&
      !directGeometryCoordinatesAreNormalized(profileCamera)
    ) {
      addIssue(issues, "invalid_coordinate", issueCamera(profileCamera.camera));
    }
  }

  return issues;
}
