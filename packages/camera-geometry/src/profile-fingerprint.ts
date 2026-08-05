import type { ProfileGeometryFingerprintV1, VehicleCameraProfileV2 } from "./types";

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, distance: number): number {
  return (value >>> distance) | (value << (32 - distance));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function profileGeometryPayload(profile: VehicleCameraProfileV2): unknown {
  return {
    anchorToleranceNormalized: profile.anchorToleranceNormalized,
    cameras: profile.cameras
      .map((camera) =>
        camera.kind === "contact_geometry"
          ? {
              anchors: camera.anchors,
              blindZones: camera.blindZones,
              camera: camera.camera,
              codec: camera.codec,
              contactBoundary: camera.contactBoundary,
              height: camera.height,
              kind: camera.kind,
              nearBodyZones: camera.nearBodyZones,
              occlusionThreshold: camera.occlusionThreshold,
              pairedCameras: [...camera.pairedCameras].sort(),
              selfVehicleMasks: camera.selfVehicleMasks,
              width: camera.width,
            }
          : {
              camera: camera.camera,
              codec: camera.codec,
              directContactGeometry: camera.directContactGeometry,
              height: camera.height,
              kind: camera.kind,
              pairedCameras: [...camera.pairedCameras].sort(),
              width: camera.width,
            },
      )
      .sort((left, right) => left.camera.localeCompare(right.camera)),
    requiredCameras: [...profile.requiredCameras].sort(),
    requiredContactCameras: [...profile.requiredContactCameras].sort(),
    schemaVersion: profile.schemaVersion,
    vehicleFamily: profile.vehicleFamily,
  };
}

function paddedMessage(input: string): Uint8Array {
  const bytes = new TextEncoder().encode(input);
  const byteLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const result = new Uint8Array(byteLength);
  result.set(bytes);
  result[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(result.buffer);
  view.setUint32(byteLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(byteLength - 4, bitLength >>> 0, false);
  return result;
}

export function sha256Hex(input: string): string {
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const message = paddedMessage(input);
  const schedule = new Uint32Array(64);
  const view = new DataView(message.buffer);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < schedule.length; index += 1) {
      const previous15 = schedule[index - 15] ?? 0;
      const previous2 = schedule[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      schedule[index] =
        ((schedule[index - 16] ?? 0) + sigma0 + (schedule[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = hash[0] ?? 0;
    let b = hash[1] ?? 0;
    let c = hash[2] ?? 0;
    let d = hash[3] ?? 0;
    let e = hash[4] ?? 0;
    let f = hash[5] ?? 0;
    let g = hash[6] ?? 0;
    let h = hash[7] ?? 0;
    for (let index = 0; index < schedule.length; index += 1) {
      const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + upperSigma1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (schedule[index] ?? 0)) >>> 0;
      const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (upperSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }

  return Array.from(hash, (value) => value.toString(16).padStart(8, "0")).join("");
}

export function profileGeometryFingerprintV1(
  profile: VehicleCameraProfileV2,
): ProfileGeometryFingerprintV1 {
  const canonicalProfile = JSON.stringify(canonicalize(profileGeometryPayload(profile)));
  return `sha256-v1:${sha256Hex(canonicalProfile)}`;
}
