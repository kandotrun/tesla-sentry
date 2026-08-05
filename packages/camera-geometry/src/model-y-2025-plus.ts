import type { VehicleCameraProfileV2 } from "./types";

export const MODEL_Y_2025_PLUS_LONG_RANGE_PROFILE_V2 = {
  anchorToleranceNormalized: 0.01,
  cameras: [
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
      anchors: [
        { x: 0.042818, y: 0.660981 },
        { x: 0.051796, y: 0.799574 },
      ],
      blindZones: [
        [
          { x: 0, y: 0 },
          { x: 0.08, y: 0 },
          { x: 0.08, y: 0.660981 },
          { x: 0, y: 0.660981 },
        ],
        [
          { x: 0, y: 0.799574 },
          { x: 0.08, y: 0.799574 },
          { x: 0.08, y: 1 },
          { x: 0, y: 1 },
        ],
      ],
      camera: "left_repeater",
      codec: "h264",
      contactBoundary: [
        {
          from: { x: 0.042818, y: 0.660981 },
          to: { x: 0.051796, y: 0.799574 },
        },
      ],
      height: 938,
      kind: "contact_geometry",
      nearBodyZones: [
        [
          { x: 0.042818, y: 0.660981 },
          { x: 0.062818, y: 0.660981 },
          { x: 0.071796, y: 0.799574 },
          { x: 0.051796, y: 0.799574 },
        ],
      ],
      occlusionThreshold: 0,
      pairedCameras: ["front", "back", "left_pillar"],
      selfVehicleMasks: [
        [
          { x: 0, y: 0.660981 },
          { x: 0.035, y: 0.660981 },
          { x: 0.044, y: 0.799574 },
          { x: 0, y: 0.799574 },
        ],
      ],
      width: 1448,
    },
    {
      anchors: [
        { x: 0.953729, y: 0.623667 },
        { x: 0.938536, y: 0.815565 },
      ],
      blindZones: [
        [
          { x: 0.92, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 0.623667 },
          { x: 0.92, y: 0.623667 },
        ],
        [
          { x: 0.92, y: 0.815565 },
          { x: 1, y: 0.815565 },
          { x: 1, y: 1 },
          { x: 0.92, y: 1 },
        ],
      ],
      camera: "right_repeater",
      codec: "h264",
      contactBoundary: [
        {
          from: { x: 0.953729, y: 0.623667 },
          to: { x: 0.938536, y: 0.815565 },
        },
      ],
      height: 938,
      kind: "contact_geometry",
      nearBodyZones: [
        [
          { x: 0.953729, y: 0.623667 },
          { x: 0.933729, y: 0.623667 },
          { x: 0.918536, y: 0.815565 },
          { x: 0.938536, y: 0.815565 },
        ],
      ],
      occlusionThreshold: 0,
      pairedCameras: ["front", "back", "right_pillar"],
      selfVehicleMasks: [
        [
          { x: 0.962, y: 0.623667 },
          { x: 1, y: 0.623667 },
          { x: 1, y: 0.815565 },
          { x: 0.947, y: 0.815565 },
        ],
      ],
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
  ],
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
} as const satisfies VehicleCameraProfileV2;
