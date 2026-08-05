import { describe, expect, it } from "vitest";
import { matchVehicleCameraProfileV2 } from "../src/match-profile";
import { sha256Hex } from "../src/profile-fingerprint";
import type { ProfileGeometryFingerprintV1, VehicleCameraProfileV2 } from "../src/types";
import { makeProfile, recordingDescriptors } from "./fixtures";

function fingerprint(profile: VehicleCameraProfileV2): ProfileGeometryFingerprintV1 {
  const result = matchVehicleCameraProfileV2(profile, recordingDescriptors());
  if (result.kind !== "matched") {
    throw new TypeError("profile must match the recording descriptors");
  }
  return result.profileGeometryFingerprint;
}

describe("profile geometry fingerprint V1", () => {
  it.each([
    {
      expected: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      input: "",
    },
    {
      expected: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      input: "abc",
    },
  ])("matches the standard SHA-256 vector for '$input'", ({ expected, input }) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it("is invariant to ordering of camera and set-like profile fields", () => {
    const reordered = structuredClone(makeProfile());
    Reflect.set(reordered, "cameras", [...reordered.cameras].reverse());
    Reflect.set(reordered, "requiredCameras", [...reordered.requiredCameras].reverse());
    Reflect.set(
      reordered,
      "requiredContactCameras",
      [...reordered.requiredContactCameras].reverse(),
    );
    for (const camera of reordered.cameras) {
      Reflect.set(camera, "pairedCameras", [...camera.pairedCameras].reverse());
    }

    expect(fingerprint(reordered)).toBe(fingerprint(makeProfile()));
  });

  it("changes when valid contact geometry changes under the same profile ID", () => {
    const changed = structuredClone(makeProfile());
    const leftRepeater = changed.cameras.find((camera) => camera.camera === "left_repeater");
    if (leftRepeater?.kind !== "contact_geometry") {
      throw new TypeError("left repeater must provide contact geometry");
    }
    Reflect.set(leftRepeater, "occlusionThreshold", 0.06);

    expect(fingerprint(changed)).not.toBe(fingerprint(makeProfile()));
  });
});
