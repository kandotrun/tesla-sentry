import { describe, expect, it } from "vitest";
import { validateVehicleCameraProfileV2 } from "../src/index";
import type { VehicleCameraProfileV2 } from "../src/types";
import {
  CONTACT_CAMERAS,
  CONTEXT_CAMERAS,
  KNOWN_CAMERAS,
  makeContactCamera,
  makeContextCamera,
  makeProfile,
  makeProfileWithLeftRepeaterPairing,
  makeProfileWithoutLeftRepeaterPairing,
  point,
  polygon,
} from "./fixtures";

function sparseArray<T>(length: number, entries: readonly (readonly [number, T])[] = []): T[] {
  const values = new Array<T>(length);
  for (const [index, value] of entries) {
    values[index] = value;
  }
  return values;
}

describe("validateVehicleCameraProfileV2", () => {
  it("accepts the exact direct-contact and context-only camera role sets", () => {
    const profile = makeProfile();

    expect(validateVehicleCameraProfileV2(profile)).toEqual([]);
    expect(profile.requiredCameras).toEqual(KNOWN_CAMERAS);
    expect(profile.requiredContactCameras).toEqual(CONTACT_CAMERAS);
    expect(
      profile.cameras
        .filter((camera) => camera.kind === "context_only")
        .map((camera) => camera.camera),
    ).toEqual(CONTEXT_CAMERAS);
  });

  it("rejects duplicate and missing camera profiles in fixed order", () => {
    const cameras = makeProfile().cameras.filter((camera) => camera.camera !== "back");
    const profile = makeProfile({ cameras: [...cameras, makeContactCamera("left_repeater")] });

    expect(validateVehicleCameraProfileV2(profile).map((issue) => issue.code)).toEqual([
      "duplicate_camera",
      "missing_required_camera",
    ]);
  });

  it("rejects a camera assigned to the wrong role", () => {
    const profile = makeProfile();
    const wrongRole = { ...makeContactCamera("left_repeater"), camera: "front" as const };
    const invalidProfile = {
      ...profile,
      cameras: [
        wrongRole,
        ...profile.cameras.filter(
          (camera) => camera.camera !== "front" && camera.camera !== "left_repeater",
        ),
      ],
    };

    expect(
      Reflect.apply(validateVehicleCameraProfileV2, undefined, [invalidProfile]),
    ).toContainEqual({ camera: "front", code: "invalid_camera_role" });
  });

  it("rejects an unknown camera profile discriminator", () => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    Reflect.set(leftRepeater, "kind", "bogus");
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "left_repeater",
      code: "invalid_camera_role",
    });
  });

  it.each([
    {
      label: "null root",
      value: null,
    },
    {
      label: "primitive root",
      value: 42,
    },
    {
      label: "empty root",
      value: {},
    },
    {
      label: "null cameras",
      value: { cameras: null },
    },
    {
      label: "sparse cameras",
      value: { ...makeProfile(), cameras: sparseArray(6) },
    },
    {
      label: "mixed sparse cameras",
      value: {
        ...makeProfile(),
        cameras: sparseArray(6, [
          [0, makeContextCamera("front")],
          [5, makeContextCamera("right_pillar")],
        ]),
      },
    },
    {
      label: "missing required camera array",
      value: { ...makeProfile(), requiredCameras: undefined },
    },
    {
      label: "non-array required contact cameras",
      value: { ...makeProfile(), requiredContactCameras: "front" },
    },
    {
      label: "sparse required cameras",
      value: { ...makeProfile(), requiredCameras: sparseArray(6) },
    },
    {
      label: "sparse required contact cameras",
      value: { ...makeProfile(), requiredContactCameras: sparseArray(2) },
    },
    {
      label: "null camera item",
      value: { ...makeProfile(), cameras: [null] },
    },
    {
      label: "camera item missing camera",
      value: {
        ...makeProfile(),
        cameras: [{ kind: "contact_geometry" }],
      },
    },
    {
      label: "camera item missing kind",
      value: {
        ...makeProfile(),
        cameras: [{ camera: "front" }],
      },
    },
    {
      label: "malformed contact geometry array",
      value: (() => {
        const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
        Reflect.set(leftRepeater, "anchors", null);
        return makeProfile({
          cameras: makeProfile().cameras.map((camera) =>
            camera.camera === "left_repeater" ? leftRepeater : camera,
          ),
        });
      })(),
    },
    {
      label: "malformed context pairing array",
      value: (() => {
        const leftPillar = structuredClone(makeContextCamera("left_pillar"));
        Reflect.set(leftPillar, "pairedCameras", null);
        return makeProfile({
          cameras: [
            leftPillar,
            ...makeProfile().cameras.filter((camera) => camera.camera !== "left_pillar"),
          ],
        });
      })(),
    },
  ])("returns invalid_profile_shape without throwing for $label", ({ value }) => {
    expect(Reflect.apply(validateVehicleCameraProfileV2, undefined, [value])).toEqual([
      { camera: null, code: "invalid_profile_shape" },
    ]);
  });

  it("rejects missing and empty direct geometry", () => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    Reflect.deleteProperty(leftRepeater, "contactBoundary");
    Reflect.set(leftRepeater, "blindZones", []);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "left_repeater",
      code: "invalid_direct_geometry",
    });
  });

  it("rejects direct geometry with fewer than two anchors", () => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    Reflect.set(leftRepeater, "anchors", [point(0.4, 0.4)]);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "left_repeater",
      code: "invalid_anchor_count",
    });
  });

  it.each([
    {
      anchors: sparseArray(2),
      label: "only holes",
    },
    {
      anchors: sparseArray(2, [[0, point(0.4, 0.4)]]),
      label: "a valid anchor and a hole",
    },
  ])("rejects sparse direct anchors containing $label", ({ anchors }) => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    Reflect.set(leftRepeater, "anchors", anchors);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "left_repeater",
      code: "invalid_anchor_count",
    });
  });

  it.each([
    {
      contactBoundary: sparseArray(1),
      label: "only a hole",
    },
    {
      contactBoundary: sparseArray(2, [[0, { from: point(0.4, 0.4), to: point(0.6, 0.4) }]]),
      label: "a valid segment and a hole",
    },
  ])("rejects a sparse contact boundary containing $label", ({ contactBoundary }) => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    Reflect.set(leftRepeater, "contactBoundary", contactBoundary);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "left_repeater",
      code: "invalid_direct_geometry",
    });
  });

  it.each(["blindZones", "nearBodyZones", "selfVehicleMasks"] as const)(
    "rejects a sparse %s collection",
    (field) => {
      const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
      Reflect.set(
        leftRepeater,
        field,
        sparseArray(2, [[0, polygon(point(0, 0), point(1, 0), point(1, 1))]]),
      );
      const profile = makeProfile({
        cameras: makeProfile().cameras.map((camera) =>
          camera.camera === "left_repeater" ? leftRepeater : camera,
        ),
      });

      expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
        camera: "left_repeater",
        code: "invalid_direct_geometry",
      });
    },
  );

  it("rejects a polygon containing a valid point and a hole without throwing", () => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    const sparsePolygon = sparseArray(3, [
      [0, point(0.1, 0.1)],
      [2, point(0.3, 0.3)],
    ]);
    Reflect.set(leftRepeater, "selfVehicleMasks", [sparsePolygon]);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "left_repeater",
      code: "invalid_polygon",
    });
  });

  it("rejects context profiles with direct geometry or invalid contact pairing", () => {
    const leftPillar = structuredClone(makeContextCamera("left_pillar"));
    Reflect.set(leftPillar, "anchors", [point(0.4, 0.4), point(0.6, 0.6)]);
    Reflect.set(leftPillar, "pairedCameras", ["right_pillar"]);
    const profile = makeProfile({
      cameras: [
        leftPillar,
        ...makeProfile().cameras.filter((camera) => camera.camera !== "left_pillar"),
      ],
    });

    expect(validateVehicleCameraProfileV2(profile)).toEqual([
      { camera: "left_pillar", code: "invalid_direct_geometry" },
      { camera: "left_pillar", code: "invalid_context_pairing" },
    ]);
  });

  it.each([
    {
      label: "missing pairing field",
      profile: makeProfileWithoutLeftRepeaterPairing,
    },
    {
      label: "non-array pairing",
      profile: () => makeProfileWithLeftRepeaterPairing("left_repeater"),
    },
    {
      label: "empty pairing",
      profile: () => makeProfileWithLeftRepeaterPairing([]),
    },
    {
      label: "null pairing element",
      profile: () => makeProfileWithLeftRepeaterPairing([null]),
    },
    {
      label: "unknown pairing element",
      profile: () => makeProfileWithLeftRepeaterPairing(["cabin"]),
    },
  ])("rejects a contact profile with $label as invalid shape", ({ profile }) => {
    expect(validateVehicleCameraProfileV2(profile())).toEqual([
      { camera: null, code: "invalid_profile_shape" },
    ]);
  });

  it.each([
    {
      label: "duplicate pairing",
      pairedCameras: ["front", "front"],
    },
    {
      label: "self pairing",
      pairedCameras: ["left_repeater"],
    },
  ])("rejects a contact profile with $label", ({ pairedCameras }) => {
    expect(
      validateVehicleCameraProfileV2(makeProfileWithLeftRepeaterPairing(pairedCameras)),
    ).toEqual([{ camera: "left_repeater", code: "invalid_contact_pairing" }]);
  });

  it.each([
    {
      label: "only a hole",
      pairedCameras: sparseArray(1),
    },
    {
      label: "valid cameras and a hole",
      pairedCameras: sparseArray(3, [
        [0, "front"],
        [2, "back"],
      ]),
    },
  ])("rejects a sparse direct pairing containing $label", ({ pairedCameras }) => {
    expect(
      validateVehicleCameraProfileV2(makeProfileWithLeftRepeaterPairing(pairedCameras)),
    ).toContainEqual({ camera: "left_repeater", code: "invalid_contact_pairing" });
  });

  it.each([
    {
      label: "only a hole",
      pairedCameras: sparseArray(1),
    },
    {
      label: "valid direct cameras and a hole",
      pairedCameras: sparseArray(3, [
        [0, "left_repeater"],
        [2, "right_repeater"],
      ]),
    },
  ])("rejects a sparse context pairing containing $label", ({ pairedCameras }) => {
    const back = structuredClone(makeContextCamera("back"));
    Reflect.set(back, "pairedCameras", pairedCameras);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) => (camera.camera === "back" ? back : camera)),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "back",
      code: "invalid_context_pairing",
    });
  });

  it("orders contact pairing issues before context pairing issues", () => {
    const profile = makeProfileWithLeftRepeaterPairing(["front", "front"]);
    const leftPillar = structuredClone(makeContextCamera("left_pillar"));
    Reflect.set(leftPillar, "pairedCameras", ["right_pillar"]);
    const invalidProfile = makeProfile({
      cameras: [...profile.cameras.filter((camera) => camera.camera !== "left_pillar"), leftPillar],
    });

    expect(validateVehicleCameraProfileV2(invalidProfile)).toEqual([
      { camera: "left_repeater", code: "invalid_contact_pairing" },
      { camera: "left_pillar", code: "invalid_context_pairing" },
    ]);
  });

  it.each(["front", "left_pillar", "right_pillar"] as const)(
    "requires the unobservable direct-geometry marker for %s",
    (contextCamera) => {
      const contextProfile = structuredClone(makeContextCamera(contextCamera));
      Reflect.set(contextProfile, "directContactGeometry", "unvalidated");
      const profile = makeProfile({
        cameras: makeProfile().cameras.map((camera) =>
          camera.camera === contextCamera ? contextProfile : camera,
        ),
      });

      expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
        camera: contextCamera,
        code: "invalid_direct_geometry",
      });
    },
  );

  it("rejects direct geometry fields on the unvalidated back context", () => {
    const back = structuredClone(makeContextCamera("back"));
    Reflect.set(back, "contactBoundary", [{ from: point(0.4, 0.4), to: point(0.6, 0.6) }]);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) => (camera.camera === "back" ? back : camera)),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "back",
      code: "invalid_direct_geometry",
    });
  });

  it("requires the unvalidated direct-geometry marker only for back", () => {
    const back = structuredClone(makeContextCamera("back"));
    Reflect.set(back, "directContactGeometry", "unobservable");
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) => (camera.camera === "back" ? back : camera)),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "back",
      code: "invalid_direct_geometry",
    });
  });

  it("rejects a profile without V2 schema provenance", () => {
    const profile = { ...makeProfile(), schemaVersion: 1 };

    expect(Reflect.apply(validateVehicleCameraProfileV2, undefined, [profile])).toEqual([
      { camera: null, code: "invalid_schema_version" },
    ]);
  });

  it.each([
    {
      label: "missing vehicle family",
      mutate: (profile: VehicleCameraProfileV2): void => {
        Reflect.deleteProperty(profile, "vehicleFamily");
      },
    },
    {
      label: "unknown vehicle family",
      mutate: (profile: VehicleCameraProfileV2): void => {
        Reflect.set(profile, "vehicleFamily", "model_3");
      },
    },
    {
      label: "missing profile ID",
      mutate: (profile: VehicleCameraProfileV2): void => {
        Reflect.deleteProperty(profile, "profileId");
      },
    },
    {
      label: "empty profile ID",
      mutate: (profile: VehicleCameraProfileV2): void => {
        Reflect.set(profile, "profileId", "  ");
      },
    },
    {
      label: "non-string profile ID",
      mutate: (profile: VehicleCameraProfileV2): void => {
        Reflect.set(profile, "profileId", 42);
      },
    },
    {
      label: "unsafe profile ID characters",
      mutate: (profile: VehicleCameraProfileV2): void => {
        Reflect.set(profile, "profileId", "model-y/../../profile");
      },
    },
    {
      label: "oversized profile ID",
      mutate: (profile: VehicleCameraProfileV2): void => {
        Reflect.set(profile, "profileId", "a".repeat(129));
      },
    },
  ])("rejects $label as invalid profile identity", ({ mutate }) => {
    const profile = structuredClone(makeProfile());
    mutate(profile);

    expect(validateVehicleCameraProfileV2(profile)).toEqual([
      { camera: null, code: "invalid_profile_identity" },
    ]);
  });

  it("rejects a forged codec on every camera in deterministic order", () => {
    const profile = structuredClone(makeProfile());
    for (const camera of profile.cameras) {
      Reflect.set(camera, "codec", "h265");
    }

    expect(validateVehicleCameraProfileV2(profile)).toEqual(
      KNOWN_CAMERAS.map((camera) => ({ camera, code: "invalid_codec" })),
    );
  });

  it("orders schema, identity, and codec issues before structural semantics", () => {
    const profile = structuredClone(makeProfile());
    Reflect.set(profile, "schemaVersion", 1);
    Reflect.set(profile, "vehicleFamily", "model_3");
    const front = profile.cameras.at(0);
    if (!front) {
      throw new RangeError("profile fixture must contain a front camera");
    }
    Reflect.set(front, "codec", "h265");

    expect(validateVehicleCameraProfileV2(profile)).toEqual([
      { camera: null, code: "invalid_schema_version" },
      { camera: null, code: "invalid_profile_identity" },
      { camera: "front", code: "invalid_codec" },
    ]);
  });

  it("rejects incorrect required camera sets", () => {
    const profile = makeProfile({
      requiredCameras: [...KNOWN_CAMERAS.slice(0, -1), "left_pillar"],
      requiredContactCameras: ["left_repeater", "right_repeater", "right_repeater"],
    });

    expect(validateVehicleCameraProfileV2(profile)).toEqual([
      { camera: null, code: "invalid_required_camera_set" },
      { camera: null, code: "invalid_required_contact_camera_set" },
    ]);
  });

  it("rejects invalid dimensions, thresholds, polygons, and coordinates in fixed order", () => {
    const leftRepeater = structuredClone(
      makeContactCamera("left_repeater", {
        height: 938.5,
        occlusionThreshold: 1.01,
        selfVehicleMasks: [polygon(point(-0.01, 0), point(1, 0), point(1, 1))],
        width: 0,
      }),
    );
    Reflect.set(leftRepeater, "nearBodyZones", [[point(0, 0), point(1, 1)]]);
    const profile = {
      ...makeProfile({
        cameras: makeProfile().cameras.map((camera) =>
          camera.camera === "left_repeater" ? leftRepeater : camera,
        ),
      }),
      anchorToleranceNormalized: -0.01,
    };

    expect(validateVehicleCameraProfileV2(profile)).toEqual([
      { camera: "left_repeater", code: "invalid_resolution" },
      { camera: null, code: "invalid_anchor_tolerance" },
      { camera: "left_repeater", code: "invalid_occlusion_threshold" },
      { camera: "left_repeater", code: "invalid_polygon" },
      { camera: "left_repeater", code: "invalid_coordinate" },
    ]);
  });

  it("checks direct anchors and contact-boundary endpoints for finite normalized coordinates", () => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    Reflect.set(leftRepeater, "anchors", [point(Number.NaN, 0), point(0.6, 0.6)]);
    Reflect.set(leftRepeater, "contactBoundary", [
      { from: point(0, 0), to: point(0, Number.POSITIVE_INFINITY) },
    ]);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toEqual([
      { camera: "left_repeater", code: "invalid_coordinate" },
    ]);
  });

  it("returns an invalid coordinate issue for a malformed contact segment", () => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    Reflect.set(leftRepeater, "contactBoundary", [null]);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "left_repeater",
      code: "invalid_coordinate",
    });
  });

  it("rejects a zero-area direct geometry polygon", () => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    Reflect.set(leftRepeater, "selfVehicleMasks", [
      [point(0.1, 0.1), point(0.2, 0.2), point(0.3, 0.3)],
    ]);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "left_repeater",
      code: "invalid_polygon",
    });
  });

  it("rejects decimal-collinear geometry within the scale-aware floating-point bound", () => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    Reflect.set(leftRepeater, "selfVehicleMasks", [
      [point(0.1, 0.3), point(0.2, 0.6), point(0.3, 0.9)],
    ]);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toContainEqual({
      camera: "left_repeater",
      code: "invalid_polygon",
    });
  });

  it("accepts a nearby small nondegenerate polygon when its area is numerically resolvable", () => {
    const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
    Reflect.set(leftRepeater, "selfVehicleMasks", [
      [point(0.1, 0.3), point(0.2, 0.6), point(0.3, 0.900_000_000_001)],
    ]);
    const profile = makeProfile({
      cameras: makeProfile().cameras.map((camera) =>
        camera.camera === "left_repeater" ? leftRepeater : camera,
      ),
    });

    expect(validateVehicleCameraProfileV2(profile)).toEqual([]);
  });

  it("does not mutate the profile", () => {
    const profile = makeProfile();
    const before = structuredClone(profile);

    validateVehicleCameraProfileV2(profile);

    expect(profile).toEqual(before);
  });
});
