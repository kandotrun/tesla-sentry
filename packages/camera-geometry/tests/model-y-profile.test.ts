import { describe, expect, it } from "vitest";
import {
  evaluateFrameGeometry,
  MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V2,
  matchVehicleCameraProfileV2,
  validateVehicleCameraProfileV2,
} from "../src/index";
import VIDEO_CONTRACT from "../src/model-y-2025-plus-video-contract.json" with { type: "json" };
import type {
  CameraRecordingDescriptor,
  ContactCameraProfileV2,
  ContactCapableTeslaCamera,
  ContextCameraProfileV2,
  ContextualTeslaCamera,
  FrameGeometryObservation,
  NormalizedPolygon,
} from "../src/types";

const PROFILE = MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V2;

function contactCamera(camera: ContactCapableTeslaCamera): ContactCameraProfileV2 {
  const result = PROFILE.cameras.find(
    (item) => item.kind === "contact_geometry" && item.camera === camera,
  );
  if (result?.kind !== "contact_geometry") {
    throw new TypeError(`Missing contact camera: ${camera}`);
  }
  return result;
}

function contextCamera(camera: ContextualTeslaCamera): ContextCameraProfileV2 {
  const result = PROFILE.cameras.find(
    (item) => item.kind === "context_only" && item.camera === camera,
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

function point(x: number, y: number): { readonly x: number; readonly y: number } {
  return { x, y };
}

function polygon(...points: NormalizedPolygon): NormalizedPolygon {
  return points;
}

function rectangle(left: number, top: number, right: number, bottom: number): NormalizedPolygon {
  return polygon(point(left, top), point(right, top), point(right, bottom), point(left, bottom));
}

function overlapObservation(camera: ContactCapableTeslaCamera): FrameGeometryObservation {
  return {
    boundaryOcclusionRatio: 0,
    camera,
    frameTimestampMs: 1_000,
    objectMask:
      camera === "left_repeater"
        ? rectangle(0.04, 0.65, 0.05, 0.67)
        : rectangle(0.95, 0.61, 0.96, 0.64),
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

describe("Model Y 2025+ Long Range profile V2", () => {
  it("exports the exact measured profile identity and required roles", () => {
    expect({
      anchorToleranceNormalized: PROFILE.anchorToleranceNormalized,
      profileId: PROFILE.profileId,
      requiredCameras: PROFILE.requiredCameras,
      requiredContactCameras: PROFILE.requiredContactCameras,
      schemaVersion: PROFILE.schemaVersion,
      vehicleFamily: PROFILE.vehicleFamily,
    }).toEqual({
      anchorToleranceNormalized: 0.01,
      profileId: "model-y-2025-plus-long-range-2896x1876-v2",
      requiredCameras: [
        "front",
        "back",
        "left_repeater",
        "right_repeater",
        "left_pillar",
        "right_pillar",
      ],
      requiredContactCameras: ["left_repeater", "right_repeater"],
      schemaVersion: 2,
      vehicleFamily: "model_y_2025_plus_long_range",
    });
  });

  it("keeps inventory verification metadata aligned with the measured profile", () => {
    expect({
      cameras: Object.fromEntries(
        PROFILE.cameras.map((camera) => [
          camera.camera,
          { codec: camera.codec, height: camera.height, width: camera.width },
        ]),
      ),
      profileId: PROFILE.profileId,
    }).toEqual(VIDEO_CONTRACT);
  });

  it("encodes the exact measured left repeater geometry", () => {
    expect(contactCamera("left_repeater")).toEqual({
      anchors: [point(0.042818, 0.660981), point(0.051796, 0.799574)],
      blindZones: [rectangle(0, 0, 0.08, 0.660981), rectangle(0, 0.799574, 0.08, 1)],
      camera: "left_repeater",
      codec: "h264",
      contactBoundary: [
        {
          from: point(0.042818, 0.660981),
          to: point(0.051796, 0.799574),
        },
      ],
      height: 938,
      kind: "contact_geometry",
      nearBodyZones: [
        polygon(
          point(0.042818, 0.660981),
          point(0.062818, 0.660981),
          point(0.071796, 0.799574),
          point(0.051796, 0.799574),
        ),
      ],
      occlusionThreshold: 0,
      pairedCameras: ["front", "back", "left_pillar"],
      selfVehicleMasks: [
        polygon(
          point(0, 0.660981),
          point(0.035, 0.660981),
          point(0.044, 0.799574),
          point(0, 0.799574),
        ),
      ],
      width: 1448,
    });
  });

  it("encodes the exact measured right repeater geometry", () => {
    expect(contactCamera("right_repeater")).toEqual({
      anchors: [point(0.953729, 0.623667), point(0.938536, 0.815565)],
      blindZones: [rectangle(0.92, 0, 1, 0.623667), rectangle(0.92, 0.815565, 1, 1)],
      camera: "right_repeater",
      codec: "h264",
      contactBoundary: [
        {
          from: point(0.953729, 0.623667),
          to: point(0.938536, 0.815565),
        },
      ],
      height: 938,
      kind: "contact_geometry",
      nearBodyZones: [
        polygon(
          point(0.953729, 0.623667),
          point(0.933729, 0.623667),
          point(0.918536, 0.815565),
          point(0.938536, 0.815565),
        ),
      ],
      occlusionThreshold: 0,
      pairedCameras: ["front", "back", "right_pillar"],
      selfVehicleMasks: [
        polygon(
          point(0.962, 0.623667),
          point(1, 0.623667),
          point(1, 0.815565),
          point(0.947, 0.815565),
        ),
      ],
      width: 1448,
    });
  });

  it("keeps all four context cameras geometry-free with exact statuses and pairings", () => {
    expect(PROFILE.cameras.filter((camera) => camera.kind === "context_only")).toEqual([
      {
        camera: "front",
        codec: "h264",
        directContactGeometry: "unobservable",
        height: 1876,
        kind: "context_only",
        pairedCameras: ["left_repeater", "right_repeater"],
        width: 2896,
      },
      {
        camera: "back",
        codec: "h264",
        directContactGeometry: "unvalidated",
        height: 938,
        kind: "context_only",
        pairedCameras: ["left_repeater", "right_repeater"],
        width: 1448,
      },
      {
        camera: "left_pillar",
        codec: "h264",
        directContactGeometry: "unobservable",
        height: 938,
        kind: "context_only",
        pairedCameras: ["left_repeater"],
        width: 1448,
      },
      {
        camera: "right_pillar",
        codec: "h264",
        directContactGeometry: "unobservable",
        height: 938,
        kind: "context_only",
        pairedCameras: ["right_repeater"],
        width: 1448,
      },
    ]);
  });

  it("passes runtime validation and matches all six valid descriptors", () => {
    expect(validateVehicleCameraProfileV2(PROFILE)).toEqual([]);
    expect(matchVehicleCameraProfileV2(PROFILE, recordingDescriptors())).toEqual({
      kind: "matched",
      profileGeometryFingerprint: expect.stringMatching(/^sha256-v1:[0-9a-f]{64}$/),
      profileId: "model-y-2025-plus-long-range-2896x1876-v2",
      schemaVersion: 2,
    });
  });

  it.each(["left_repeater", "right_repeater"] as const)(
    "evaluates measured overlap for %s",
    (camera) => {
      expect(evaluateFrameGeometry(PROFILE, overlapObservation(camera))).toMatchObject({
        camera,
        source: "contact_geometry",
        state: "boundary_overlap",
      });
    },
  );

  it.each(["front", "back", "left_pillar", "right_pillar"] as const)(
    "rejects runtime frame evaluation for the %s context camera",
    (camera) => {
      const error = captureError(() =>
        Reflect.apply(evaluateFrameGeometry, undefined, [
          contextCamera(camera),
          overlapObservation("left_repeater"),
        ]),
      );

      expect(error).toEqual(new TypeError("profile must be a valid V2 vehicle camera profile"));
    },
  );

  it("accepts both direct anchors at the one-percent tolerance boundary", () => {
    const descriptors = recordingDescriptors().map((descriptor) =>
      descriptor.camera === "left_repeater" || descriptor.camera === "right_repeater"
        ? { ...descriptor, anchorErrorNormalized: 0.01 }
        : descriptor,
    );

    expect(matchVehicleCameraProfileV2(PROFILE, descriptors).kind).toBe("matched");
  });

  it("rejects a measured direct anchor above the one-percent tolerance", () => {
    const descriptors = recordingDescriptors().map((descriptor) =>
      descriptor.camera === "right_repeater"
        ? { ...descriptor, anchorErrorNormalized: 0.010_001 }
        : descriptor,
    );

    expect(matchVehicleCameraProfileV2(PROFILE, descriptors)).toEqual({
      kind: "mismatched",
      reasons: ["anchor_drift"],
    });
  });

  it("fails closed when either measured direct anchor is unavailable", () => {
    for (const camera of ["left_repeater", "right_repeater"] as const) {
      const descriptors = recordingDescriptors().map((descriptor) =>
        descriptor.camera === camera ? { ...descriptor, anchorErrorNormalized: null } : descriptor,
      );

      expect(matchVehicleCameraProfileV2(PROFILE, descriptors)).toEqual({
        kind: "mismatched",
        reasons: ["anchor_unavailable"],
      });
    }
  });

  it("does not mutate the profile, descriptors, or observations", () => {
    const descriptors = recordingDescriptors();
    const observation = overlapObservation("left_repeater");
    const profileBefore = structuredClone(PROFILE);
    const descriptorsBefore = structuredClone(descriptors);
    const observationBefore = structuredClone(observation);

    matchVehicleCameraProfileV2(PROFILE, descriptors);
    evaluateFrameGeometry(PROFILE, observation);

    expect(PROFILE).toEqual(profileBefore);
    expect(descriptors).toEqual(descriptorsBefore);
    expect(observation).toEqual(observationBefore);
  });
});
