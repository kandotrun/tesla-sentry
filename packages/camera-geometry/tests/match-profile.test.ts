import { describe, expect, it } from "vitest";
import { matchVehicleCameraProfileV2 } from "../src/index";
import {
  CONTEXT_CAMERAS,
  makeContactCamera,
  makeContextCamera,
  makeProfile,
  makeProfileWithLeftRepeaterPairing,
  makeProfileWithoutLeftRepeaterPairing,
  recordingDescriptors,
} from "./fixtures";

describe("matchVehicleCameraProfileV2", () => {
  it("matches all six recordings with null context anchor errors", () => {
    expect(matchVehicleCameraProfileV2(makeProfile(), recordingDescriptors())).toEqual({
      kind: "matched",
      profileGeometryFingerprint: expect.stringMatching(/^sha256-v1:[0-9a-f]{64}$/),
      profileId: "synthetic-profile-v2",
      schemaVersion: 2,
    });
  });

  it("fails closed when a required camera is missing", () => {
    const descriptors = recordingDescriptors().filter((item) => item.camera !== "back");

    expect(matchVehicleCameraProfileV2(makeProfile(), descriptors)).toEqual({
      kind: "mismatched",
      reasons: ["missing_required_camera"],
    });
  });

  it.each([
    {
      label: "contact pairing is missing",
      profile: makeProfileWithoutLeftRepeaterPairing,
    },
    {
      label: "contact pairing is not an array",
      profile: () => makeProfileWithLeftRepeaterPairing("left_repeater"),
    },
    {
      label: "contact pairing is empty",
      profile: () => makeProfileWithLeftRepeaterPairing([]),
    },
    {
      label: "contact pairing contains null",
      profile: () => makeProfileWithLeftRepeaterPairing([null]),
    },
    {
      label: "contact pairing contains an unknown camera",
      profile: () => makeProfileWithLeftRepeaterPairing(["cabin"]),
    },
    {
      label: "contact pairing contains duplicates",
      profile: () => makeProfileWithLeftRepeaterPairing(["front", "front"]),
    },
    {
      label: "contact pairing references itself",
      profile: () => makeProfileWithLeftRepeaterPairing(["left_repeater"]),
    },
  ])("fails closed when $label", ({ profile }) => {
    expect(matchVehicleCameraProfileV2(profile(), recordingDescriptors())).toEqual({
      kind: "mismatched",
      reasons: ["invalid_profile"],
    });
  });

  it.each([
    {
      label: "schema version is not V2",
      profile: () => ({ ...makeProfile(), schemaVersion: 1 }),
    },
    {
      label: "required contact camera set is invalid",
      profile: () =>
        makeProfile({
          requiredContactCameras: ["left_repeater", "right_repeater", "right_repeater"],
        }),
    },
    {
      label: "profile camera is duplicated",
      profile: () =>
        makeProfile({ cameras: [...makeProfile().cameras, makeContactCamera("left_repeater")] }),
    },
    {
      label: "camera has the wrong role",
      profile: () => {
        const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
        Reflect.set(leftRepeater, "camera", "front");
        return makeProfile({
          cameras: makeProfile().cameras.map((camera) =>
            camera.camera === "left_repeater" ? leftRepeater : camera,
          ),
        });
      },
    },
    {
      label: "camera discriminator is unknown",
      profile: () => {
        const leftRepeater = structuredClone(makeContactCamera("left_repeater"));
        Reflect.set(leftRepeater, "kind", "bogus");
        return makeProfile({
          cameras: makeProfile().cameras.map((camera) =>
            camera.camera === "left_repeater" ? leftRepeater : camera,
          ),
        });
      },
    },
    {
      label: "context pairing is invalid",
      profile: () => {
        const leftPillar = structuredClone(makeContextCamera("left_pillar"));
        Reflect.set(leftPillar, "pairedCameras", ["right_pillar"]);
        return makeProfile({
          cameras: [
            leftPillar,
            ...makeProfile().cameras.filter((camera) => camera.camera !== "left_pillar"),
          ],
        });
      },
    },
    {
      label: "vehicle family is invalid",
      profile: () => {
        const profile = structuredClone(makeProfile());
        Reflect.set(profile, "vehicleFamily", "model_3");
        return profile;
      },
    },
    {
      label: "profile ID is missing",
      profile: () => {
        const profile = structuredClone(makeProfile());
        Reflect.deleteProperty(profile, "profileId");
        return profile;
      },
    },
    {
      label: "camera codec is forged",
      profile: () => {
        const profile = structuredClone(makeProfile());
        for (const camera of profile.cameras) {
          Reflect.set(camera, "codec", "h265");
        }
        return profile;
      },
    },
  ])("fails closed when the $label", ({ profile }) => {
    expect(
      Reflect.apply(matchVehicleCameraProfileV2, undefined, [profile(), recordingDescriptors()]),
    ).toEqual({
      kind: "mismatched",
      reasons: ["invalid_profile"],
    });
  });

  it("validates codec, dimensions, rotation, and crop for a context camera", () => {
    const descriptors = recordingDescriptors().map((item) =>
      item.camera === "left_pillar"
        ? { ...item, codec: "h265", cropped: true, rotationDegrees: 90, width: 100 }
        : item,
    );

    expect(matchVehicleCameraProfileV2(makeProfile(), descriptors)).toEqual({
      kind: "mismatched",
      reasons: ["codec_mismatch", "resolution_mismatch", "rotation_mismatch", "cropped_input"],
    });
  });

  it("accepts direct anchor errors at zero and tolerance", () => {
    const atZero = recordingDescriptors().map((item) =>
      item.camera === "left_repeater" ? { ...item, anchorErrorNormalized: 0 } : item,
    );
    const atTolerance = recordingDescriptors().map((item) =>
      item.camera === "left_repeater" ? { ...item, anchorErrorNormalized: 0.01 } : item,
    );

    expect(matchVehicleCameraProfileV2(makeProfile(), atZero).kind).toBe("matched");
    expect(matchVehicleCameraProfileV2(makeProfile(), atTolerance).kind).toBe("matched");
  });

  it("distinguishes an unavailable direct anchor from drift", () => {
    const nullDirectAnchor = recordingDescriptors().map((item) =>
      item.camera === "left_repeater" ? { ...item, anchorErrorNormalized: null } : item,
    );

    expect(matchVehicleCameraProfileV2(makeProfile(), nullDirectAnchor)).toEqual({
      kind: "mismatched",
      reasons: ["anchor_unavailable"],
    });
  });

  it.each([
    { anchorErrorNormalized: 0.010_001, label: "above tolerance" },
    { anchorErrorNormalized: -0.001, label: "negative" },
    { anchorErrorNormalized: Number.NaN, label: "NaN" },
    { anchorErrorNormalized: Number.POSITIVE_INFINITY, label: "infinity" },
  ])("rejects a direct anchor error that is $label as drift", ({ anchorErrorNormalized }) => {
    const descriptors = recordingDescriptors().map((item) =>
      item.camera === "left_repeater" ? { ...item, anchorErrorNormalized } : item,
    );

    expect(matchVehicleCameraProfileV2(makeProfile(), descriptors)).toEqual({
      kind: "mismatched",
      reasons: ["anchor_drift"],
    });
  });

  it("orders unavailable and drifting direct anchors deterministically", () => {
    const descriptors = recordingDescriptors().map((item) => {
      if (item.camera === "left_repeater") {
        return { ...item, anchorErrorNormalized: null };
      }
      if (item.camera === "right_repeater") {
        return { ...item, anchorErrorNormalized: Number.NaN };
      }
      return item;
    });

    expect(matchVehicleCameraProfileV2(makeProfile(), descriptors)).toEqual({
      kind: "mismatched",
      reasons: ["anchor_unavailable", "anchor_drift"],
    });
  });

  it.each(CONTEXT_CAMERAS)("requires a null anchor error for the %s context camera", (camera) => {
    const descriptors = recordingDescriptors().map((item) =>
      item.camera === camera ? { ...item, anchorErrorNormalized: 0 } : item,
    );

    expect(matchVehicleCameraProfileV2(makeProfile(), descriptors)).toEqual({
      kind: "mismatched",
      reasons: ["anchor_drift"],
    });
  });

  it("reports every independent direct recording mismatch in fixed order", () => {
    const descriptors = recordingDescriptors().map((item) =>
      item.camera === "left_repeater"
        ? { ...item, anchorErrorNormalized: Number.NaN, codec: "h265", cropped: true, width: 100 }
        : item,
    );

    expect(matchVehicleCameraProfileV2(makeProfile(), descriptors)).toEqual({
      kind: "mismatched",
      reasons: ["codec_mismatch", "resolution_mismatch", "anchor_drift", "cropped_input"],
    });
  });

  it("does not mutate the profile or recording descriptors", () => {
    const profile = makeProfile();
    const descriptors = recordingDescriptors();
    const profileBefore = structuredClone(profile);
    const descriptorsBefore = structuredClone(descriptors);

    matchVehicleCameraProfileV2(profile, descriptors);

    expect(profile).toEqual(profileBefore);
    expect(descriptors).toEqual(descriptorsBefore);
  });
});
