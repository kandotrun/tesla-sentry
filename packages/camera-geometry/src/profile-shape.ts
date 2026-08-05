import type { KnownTeslaCamera } from "@sentry-check/teslacam-parser";
import type { NormalizedPoint } from "./types";

export interface InspectableCameraProfile {
  readonly anchors?: unknown;
  readonly blindZones?: unknown;
  readonly camera: unknown;
  readonly codec?: unknown;
  readonly contactBoundary?: unknown;
  readonly directContactGeometry?: unknown;
  readonly height?: unknown;
  readonly kind: unknown;
  readonly nearBodyZones?: unknown;
  readonly occlusionThreshold?: unknown;
  readonly pairedCameras?: unknown;
  readonly selfVehicleMasks?: unknown;
  readonly width?: unknown;
}

export interface InspectableContactCameraProfile extends InspectableCameraProfile {
  readonly kind: "contact_geometry";
  readonly pairedCameras: readonly KnownTeslaCamera[];
}

export interface InspectableContextCameraProfile extends InspectableCameraProfile {
  readonly kind: "context_only";
}

export interface InspectableDirectGeometryProfile extends InspectableContactCameraProfile {
  readonly anchors: readonly unknown[];
  readonly blindZones: readonly unknown[];
  readonly contactBoundary: readonly unknown[];
  readonly nearBodyZones: readonly unknown[];
  readonly selfVehicleMasks: readonly unknown[];
}

export interface InspectableVehicleCameraProfile {
  readonly anchorToleranceNormalized?: unknown;
  readonly cameras: readonly InspectableCameraProfile[];
  readonly profileId?: unknown;
  readonly requiredCameras: readonly unknown[];
  readonly requiredContactCameras: readonly unknown[];
  readonly schemaVersion?: unknown;
  readonly vehicleFamily?: unknown;
}

const CONTACT_GEOMETRY_ARRAY_FIELDS = [
  "anchors",
  "blindZones",
  "contactBoundary",
  "nearBodyZones",
  "selfVehicleMasks",
] as const;

function isKnownTeslaCamera(value: unknown): value is KnownTeslaCamera {
  return (
    value === "front" ||
    value === "back" ||
    value === "left_repeater" ||
    value === "right_repeater" ||
    value === "left_pillar" ||
    value === "right_pillar"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function arrayHasNoHoles(values: readonly unknown[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index)) {
      return false;
    }
  }
  return true;
}

function isDenseNonEmptyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length > 0 && arrayHasNoHoles(value);
}

function isInspectableCameraProfile(value: unknown): value is InspectableCameraProfile {
  if (!isRecord(value) || !("camera" in value) || !("kind" in value)) {
    return false;
  }
  if (value.kind === "contact_geometry") {
    return (
      CONTACT_GEOMETRY_ARRAY_FIELDS.every(
        (field) => !(field in value) || Array.isArray(value[field]),
      ) &&
      Array.isArray(value.pairedCameras) &&
      value.pairedCameras.length > 0 &&
      value.pairedCameras.every(isKnownTeslaCamera)
    );
  }
  if (value.kind === "context_only") {
    return !("pairedCameras" in value) || Array.isArray(value.pairedCameras);
  }
  return true;
}

export function isInspectableVehicleCameraProfile(
  value: unknown,
): value is InspectableVehicleCameraProfile {
  return (
    isRecord(value) &&
    Array.isArray(value.cameras) &&
    arrayHasNoHoles(value.cameras) &&
    value.cameras.every(isInspectableCameraProfile) &&
    Array.isArray(value.requiredCameras) &&
    arrayHasNoHoles(value.requiredCameras) &&
    Array.isArray(value.requiredContactCameras) &&
    arrayHasNoHoles(value.requiredContactCameras)
  );
}

export function isInspectableContactCameraProfile(
  camera: InspectableCameraProfile,
): camera is InspectableContactCameraProfile {
  return camera.kind === "contact_geometry";
}

export function isInspectableContextCameraProfile(
  camera: InspectableCameraProfile,
): camera is InspectableContextCameraProfile {
  return camera.kind === "context_only";
}

export function hasInspectableDirectGeometry(
  camera: InspectableContactCameraProfile,
): camera is InspectableDirectGeometryProfile {
  return (
    !("directContactGeometry" in camera) &&
    isDenseNonEmptyArray(camera.anchors) &&
    isDenseNonEmptyArray(camera.blindZones) &&
    isDenseNonEmptyArray(camera.contactBoundary) &&
    isDenseNonEmptyArray(camera.nearBodyZones) &&
    isDenseNonEmptyArray(camera.selfVehicleMasks)
  );
}

export function isNormalizedValue(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNormalizedPoint(value: unknown): value is NormalizedPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    isNormalizedValue(value.x) &&
    isNormalizedValue(value.y)
  );
}

function isNormalizedSegment(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "from" in value &&
    "to" in value &&
    isNormalizedPoint(value.from) &&
    isNormalizedPoint(value.to)
  );
}

function polygonHasNonZeroArea(polygon: readonly unknown[]): boolean {
  if (!arrayHasNoHoles(polygon)) {
    return false;
  }
  if (!polygon.every(isNormalizedPoint)) {
    return true;
  }
  const lastPoint = polygon.at(-1);
  if (!lastPoint) {
    return false;
  }

  let twiceArea = 0;
  let productMagnitude = 0;
  let previous = lastPoint;
  for (const current of polygon) {
    const forwardProduct = previous.x * current.y;
    const backwardProduct = current.x * previous.y;
    twiceArea += forwardProduct - backwardProduct;
    productMagnitude += Math.abs(forwardProduct) + Math.abs(backwardProduct);
    previous = current;
  }
  const operationCount = polygon.length * 4;
  const relativeError = operationCount * Number.EPSILON;
  const errorBound = productMagnitude * (relativeError / (1 - relativeError));
  return Math.abs(twiceArea) > errorBound;
}

export function directGeometryPolygonsAreValid(camera: InspectableDirectGeometryProfile): boolean {
  const polygons = [...camera.selfVehicleMasks, ...camera.nearBodyZones, ...camera.blindZones];
  return polygons.every(
    (polygon) =>
      Array.isArray(polygon) &&
      arrayHasNoHoles(polygon) &&
      polygon.length >= 3 &&
      polygonHasNonZeroArea(polygon),
  );
}

export function directGeometryCoordinatesAreNormalized(
  camera: InspectableDirectGeometryProfile,
): boolean {
  const polygons = [...camera.selfVehicleMasks, ...camera.nearBodyZones, ...camera.blindZones];
  return (
    arrayHasNoHoles(camera.anchors) &&
    camera.anchors.every(isNormalizedPoint) &&
    polygons.every(
      (polygon) =>
        Array.isArray(polygon) && arrayHasNoHoles(polygon) && polygon.every(isNormalizedPoint),
    ) &&
    arrayHasNoHoles(camera.contactBoundary) &&
    camera.contactBoundary.every(isNormalizedSegment)
  );
}
