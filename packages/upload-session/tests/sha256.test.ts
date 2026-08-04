import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StreamingSha256 } from "../src/sha256";

function nodeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashWithStreaming(bytes: Uint8Array, chunkSize: number): string {
  const hasher = new StreamingSha256();
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    hasher.update(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return hasher.digestHex();
}

describe("StreamingSha256", () => {
  it("matches node crypto for empty input", () => {
    expect(hashWithStreaming(new Uint8Array(0), 64)).toBe(nodeSha256(new Uint8Array(0)));
  });

  it("matches node crypto across padding-boundary lengths", () => {
    // Padding behavior changes around multiples of 64; cover 0..130 densely.
    for (let length = 0; length <= 130; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        bytes[i] = (i * 31 + 7) % 256;
      }
      expect(hashWithStreaming(bytes, 64), `length=${length}`).toBe(nodeSha256(bytes));
    }
  });

  it("matches node crypto with many chunk splittings", () => {
    const bytes = new Uint8Array(10_000);
    for (let i = 0; i < bytes.byteLength; i += 1) {
      bytes[i] = (i * 173 + 11) % 256;
    }
    const expected = nodeSha256(bytes);
    for (const chunkSize of [1, 7, 63, 64, 65, 128, 4096, 10_000]) {
      expect(hashWithStreaming(bytes, chunkSize), `chunk=${chunkSize}`).toBe(expected);
    }
  });

  it("matches node crypto on pseudorandom data", () => {
    const bytes = new Uint8Array(156_500);
    let seed = 0x2f6e2b1;
    for (let i = 0; i < bytes.byteLength; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      bytes[i] = seed % 256;
    }
    const expected = nodeSha256(bytes);
    expect(hashWithStreaming(bytes, 256 * 1024)).toBe(expected);
    expect(hashWithStreaming(bytes, 65_536)).toBe(expected);
    expect(hashWithStreaming(bytes, 1)).toBe(expected);
  });
});
