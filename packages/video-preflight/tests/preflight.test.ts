import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { classifyVideoMetadata, preflightMp4, type VideoMetadata } from "../src/index";

const MiB = 1024 * 1024;
const ADVERSARIAL_BOX_COUNT = 10_000;

async function syntheticAvc(): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await readFile(new URL("./fixtures/one-second-avc.mp4", import.meta.url));
  return Uint8Array.from(bytes);
}

function topLevelBox(bytes: Uint8Array<ArrayBuffer>, type: string): Uint8Array<ArrayBuffer> {
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const size = view.getUint32(0);
    const currentType = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > bytes.byteLength) {
      break;
    }
    if (currentType === type) {
      return bytes.slice(offset, offset + size);
    }
    offset += size;
  }
  throw new Error(`Synthetic fixture is missing ${type}`);
}

function largeMdat(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  bytes.set(new TextEncoder().encode("mdat"), 4);
  return bytes;
}

function box(type: string, payload: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

function concatenate(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function withSmallAudioTrack(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const mdhdPayload = new Uint8Array(20);
  const mdhdView = new DataView(mdhdPayload.buffer);
  mdhdView.setUint32(12, 1);
  mdhdView.setUint32(16, 1);

  const hdlrPayload = new Uint8Array(12);
  hdlrPayload.set(new TextEncoder().encode("soun"), 8);

  const audioEntry = box("mp4a", new Uint8Array(28));
  const stsdPayload = new Uint8Array(8 + audioEntry.byteLength);
  new DataView(stsdPayload.buffer).setUint32(4, 1);
  stsdPayload.set(audioEntry, 8);
  const audioTrack = box(
    "trak",
    box(
      "mdia",
      concatenate(
        box("mdhd", mdhdPayload),
        box("hdlr", hdlrPayload),
        box("minf", box("stbl", box("stsd", stsdPayload))),
      ),
    ),
  );

  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const size = view.getUint32(0);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > bytes.byteLength) {
      break;
    }
    if (type === "moov") {
      const result = new Uint8Array(bytes.byteLength + audioTrack.byteLength);
      result.set(bytes.subarray(0, offset + size));
      result.set(audioTrack, offset + size);
      result.set(bytes.subarray(offset + size), offset + size + audioTrack.byteLength);
      new DataView(result.buffer).setUint32(offset, size + audioTrack.byteLength);
      return result;
    }
    offset += size;
  }
  throw new Error("Synthetic fixture is missing moov");
}

function extendedFreeBox(size: bigint): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1);
  bytes.set(new TextEncoder().encode("free"), 4);
  view.setBigUint64(8, size);
  return bytes;
}

function withSampleCount(
  bytes: Uint8Array<ArrayBuffer>,
  sampleCount: number,
): Uint8Array<ArrayBuffer> {
  const copy = bytes.slice();
  const marker = new TextEncoder().encode("stsz");
  for (let offset = 4; offset + 16 <= copy.byteLength; offset += 1) {
    if (marker.every((byte, index) => copy[offset + index] === byte)) {
      new DataView(copy.buffer).setUint32(offset + 12, sampleCount);
      return copy;
    }
  }
  throw new Error("Synthetic fixture is missing stsz");
}

function markerOffset(bytes: Uint8Array<ArrayBuffer>, type: string): number {
  const marker = new TextEncoder().encode(type);
  for (let offset = 4; offset + marker.byteLength <= bytes.byteLength; offset += 1) {
    if (marker.every((byte, index) => bytes[offset + index] === byte)) {
      return offset;
    }
  }
  throw new Error(`Synthetic fixture is missing ${type}`);
}

function withBoxType(
  bytes: Uint8Array<ArrayBuffer>,
  currentType: string,
  nextType: string,
): Uint8Array<ArrayBuffer> {
  const copy = bytes.slice();
  copy.set(new TextEncoder().encode(nextType), markerOffset(copy, currentType));
  return copy;
}

function withSampleEntryType(
  bytes: Uint8Array<ArrayBuffer>,
  sampleEntryType: string,
): Uint8Array<ArrayBuffer> {
  if (!/^[ -~]{4}$/.test(sampleEntryType)) {
    throw new Error("Sample entry type must be four printable ASCII characters");
  }
  const copy = bytes.slice();
  const stsdTypeOffset = markerOffset(copy, "stsd");
  copy.set(new TextEncoder().encode(sampleEntryType), stsdTypeOffset + 16);
  if (/^(?:hvc|hev)/.test(sampleEntryType)) {
    copy.set(new TextEncoder().encode("hvcC"), markerOffset(copy, "avcC"));
  }
  return copy;
}

function withSecondSampleEntryType(
  bytes: Uint8Array<ArrayBuffer>,
  sampleEntryType: string,
): Uint8Array<ArrayBuffer> {
  const copy = bytes.slice();
  const stsdStart = markerOffset(copy, "stsd") - 4;
  const view = new DataView(copy.buffer);
  const stsdSize = view.getUint32(stsdStart);
  const firstEntryStart = stsdStart + 16;
  const firstEntrySize = view.getUint32(firstEntryStart);
  const secondEntry = copy.slice(firstEntryStart, firstEntryStart + firstEntrySize);
  secondEntry.set(new TextEncoder().encode(sampleEntryType), 4);
  const insertAt = stsdStart + stsdSize;
  const result = new Uint8Array(copy.byteLength + secondEntry.byteLength);
  result.set(copy.subarray(0, insertAt));
  result.set(secondEntry, insertAt);
  result.set(copy.subarray(insertAt), insertAt + secondEntry.byteLength);

  const resultView = new DataView(result.buffer);
  for (const parentType of ["moov", "trak", "mdia", "minf", "stbl", "stsd"]) {
    const parentStart = markerOffset(copy, parentType) - 4;
    resultView.setUint32(parentStart, view.getUint32(parentStart) + secondEntry.byteLength);
  }
  resultView.setUint32(stsdStart + 12, 2);
  return result;
}

function withSampleEntrySize(
  bytes: Uint8Array<ArrayBuffer>,
  sampleEntrySize: number,
): Uint8Array<ArrayBuffer> {
  const copy = bytes.slice();
  const marker = new TextEncoder().encode("stsd");
  for (let offset = 4; offset + 20 <= copy.byteLength; offset += 1) {
    if (marker.every((byte, index) => copy[offset + index] === byte)) {
      new DataView(copy.buffer).setUint32(offset + 12, sampleEntrySize);
      return copy;
    }
  }
  throw new Error("Synthetic fixture is missing stsd");
}

function freeBoxFlood(boxCount: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(boxCount * 8);
  const view = new DataView(bytes.buffer);
  const type = new TextEncoder().encode("free");
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    view.setUint32(offset, 8);
    bytes.set(type, offset + 4);
  }
  return bytes;
}

function withNestedFreeBoxFlood(
  bytes: Uint8Array<ArrayBuffer>,
  boxCount: number,
): Uint8Array<ArrayBuffer> {
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const size = view.getUint32(0);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > bytes.byteLength) {
      break;
    }
    if (type === "moov") {
      const flood = freeBoxFlood(boxCount);
      const result = new Uint8Array(bytes.byteLength + flood.byteLength);
      result.set(bytes.subarray(0, offset + size));
      result.set(flood, offset + size);
      result.set(bytes.subarray(offset + size), offset + size + flood.byteLength);
      new DataView(result.buffer).setUint32(offset, size + flood.byteLength);
      return result;
    }
    offset += size;
  }
  throw new Error("Synthetic fixture is missing moov");
}

function repeatedFreeBoxes(totalSize: number, boxSize = MiB): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);
  const type = new TextEncoder().encode("free");
  for (let offset = 0; offset < totalSize; offset += boxSize) {
    view.setUint32(offset, Math.min(boxSize, totalSize - offset));
    bytes.set(type, offset + 4);
  }
  return bytes;
}

function metadata(overrides: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    codec: "avc1.42c00a",
    durationSeconds: 60,
    encrypted: false,
    height: 960,
    scannedBytes: 1024,
    width: 1280,
    ...overrides,
  };
}

describe("classifyVideoMetadata", () => {
  it("marks encrypted video for review before codec support is considered", () => {
    expect(classifyVideoMetadata(metadata({ codec: "encv", encrypted: true })).code).toBe(
      "encrypted",
    );
  });

  it("accepts the H.265 sample-entry families", () => {
    expect(classifyVideoMetadata(metadata({ codec: "hvc1.1.6.L93.B0" })).code).toBe("ready");
    expect(classifyVideoMetadata(metadata({ codec: "hev1.2.4.L120.B0" })).code).toBe("ready");
  });

  it("marks codecs outside the Tesla H.264/HEVC allowlist for review", () => {
    expect(classifyVideoMetadata(metadata({ codec: "vp09.00.10.08" })).code).toBe(
      "unsupported_codec",
    );
  });

  it("does not call metadata without a video track ready", () => {
    expect(
      classifyVideoMetadata(
        metadata({ codec: null, durationSeconds: null, height: null, width: null }),
      ).code,
    ).toBe("missing_video_track");
  });
});

describe("preflightMp4", () => {
  it("reads duration, codec and dimensions from a synthetic AVC MP4", async () => {
    const bytes = await syntheticAvc();

    const result = await preflightMp4(new Blob([bytes], { type: "video/mp4" }));

    expect(result.code).toBe("ready");
    expect(result.durationSeconds).toBeCloseTo(1, 1);
    expect(result.codec).toMatch(/^avc1/i);
    expect(result.width).toBe(160);
    expect(result.height).toBe(90);
    expect(result.scannedBytes).toBeLessThanOrEqual(bytes.byteLength);
  });

  it.each([
    { expectedCode: "encrypted", sampleEntryType: "encv" },
    { expectedCode: "unsupported_codec", sampleEntryType: "vp09" },
    { expectedCode: "ready", sampleEntryType: "hvc1" },
  ] as const)(
    "classifies the $sampleEntryType sample entry as $expectedCode",
    async ({ expectedCode, sampleEntryType }) => {
      const fixture = withSampleEntryType(await syntheticAvc(), sampleEntryType);

      const result = await preflightMp4(new Blob([fixture], { type: "video/mp4" }));

      expect(result.codec).toBe(sampleEntryType);
      expect(result.code).toBe(expectedCode);
    },
  );

  it("marks the track encrypted when any declared sample entry is encrypted", async () => {
    const fixture = withSecondSampleEntryType(await syntheticAvc(), "encv");

    const result = await preflightMp4(new Blob([fixture], { type: "video/mp4" }));

    expect(result.code).toBe("encrypted");
    expect(result.codec).toBe("avc1");
    expect(result.encrypted).toBe(true);
  });

  it("marks the track unsupported when any unencrypted sample entry is unsupported", async () => {
    const fixture = withSecondSampleEntryType(await syntheticAvc(), "vp09");

    const result = await preflightMp4(new Blob([fixture], { type: "video/mp4" }));

    expect(result.code).toBe("unsupported_codec");
    expect(result.codec).toBe("vp09");
    expect(result.encrypted).toBe(false);
  });

  it("rejects a supported sample entry without its codec configuration box", async () => {
    const fixture = withBoxType(await syntheticAvc(), "avcC", "free");

    const result = await preflightMp4(new Blob([fixture], { type: "video/mp4" }));

    expect(result.code).toBe("invalid_container");
    expect(result.codec).toBeNull();
  });

  it("ignores non-video sample-entry layouts while keeping a valid video track", async () => {
    const fixture = withSmallAudioTrack(await syntheticAvc());

    const result = await preflightMp4(new Blob([fixture], { type: "video/mp4" }));

    expect(result.code).toBe("ready");
    expect(result.codec).toBe("avc1");
  });

  it("accepts a bounded 64-bit top-level box size", async () => {
    const fixture = await syntheticAvc();
    const ftyp = topLevelBox(fixture, "ftyp");
    const moov = topLevelBox(fixture, "moov");

    const result = await preflightMp4(
      new Blob([ftyp, extendedFreeBox(16n), moov], { type: "video/mp4" }),
    );

    expect(result.code).toBe("ready");
  });

  it("rejects a 64-bit box size outside JavaScript's safe integer range", async () => {
    const unsafeSize = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

    const result = await preflightMp4(
      new Blob([extendedFreeBox(unsafeSize)], { type: "video/mp4" }),
    );

    expect(result.code).toBe("invalid_container");
    expect(result.scannedBytes).toBe(16);
  });

  it.each([0, 8, 85, 86])(
    "rejects a malformed video sample entry declared as %i bytes",
    async (sampleEntrySize) => {
      const fixture = withSampleEntrySize(await syntheticAvc(), sampleEntrySize);

      const result = await preflightMp4(new Blob([fixture], { type: "video/mp4" }));

      expect(result.code).toBe("invalid_container");
      expect(result.codec).toBeNull();
    },
  );

  it("rejects a top-level box-count flood before parsing attacker-controlled box objects", async () => {
    const fixture = await syntheticAvc();
    const ftyp = topLevelBox(fixture, "ftyp");
    const moov = topLevelBox(fixture, "moov");
    const video = new Blob([ftyp, freeBoxFlood(ADVERSARIAL_BOX_COUNT), largeMdat(8 * MiB), moov], {
      type: "video/mp4",
    });

    const result = await preflightMp4(video);

    expect(result.code).toBe("invalid_container");
    expect(result.scannedBytes).toBeLessThanOrEqual(MiB);
  });

  it("rejects a nested container box-count flood", async () => {
    const fixture = withNestedFreeBoxFlood(await syntheticAvc(), ADVERSARIAL_BOX_COUNT);

    const result = await preflightMp4(new Blob([fixture], { type: "video/mp4" }));

    expect(result.code).toBe("invalid_container");
  });

  it("does not expand untrusted per-sample table counts", async () => {
    const fixture = withSampleCount(await syntheticAvc(), 10_000_000);
    const startedAt = performance.now();

    const result = await preflightMp4(new Blob([fixture], { type: "video/mp4" }));

    expect(result.code).toBe("ready");
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("seeks over a large media-data box instead of reading the full video", async () => {
    const fixture = await syntheticAvc();
    const ftyp = topLevelBox(fixture, "ftyp");
    const moov = topLevelBox(fixture, "moov");
    const video = new Blob([ftyp, largeMdat(8 * MiB), moov], { type: "video/mp4" });

    const result = await preflightMp4(video, {
      chunkBytes: 64 * 1024,
      maxMetadataBytes: 2 * MiB,
    });

    expect(result.code).toBe("ready");
    expect(result.scannedBytes).toBeLessThan(2 * MiB);
    expect(result.scannedBytes).toBeLessThan(video.size / 2);
  });

  it("returns a bounded review result when metadata cannot be found", async () => {
    const video = new Blob([largeMdat(8 * MiB)], { type: "video/mp4" });

    const result = await preflightMp4(video, {
      chunkBytes: 64 * 1024,
      maxMetadataBytes: 512 * 1024,
    });

    expect(result.code).toBe("metadata_not_found");
    expect(result.scannedBytes).toBeLessThanOrEqual(512 * 1024);
  });

  it("hard-caps metadata reads at 8 MiB", async () => {
    const video = new Blob([repeatedFreeBoxes(9 * MiB)], { type: "video/mp4" });

    const result = await preflightMp4(video, {
      chunkBytes: MiB,
      maxMetadataBytes: 16 * MiB,
    });

    expect(result.code).toBe("metadata_not_found");
    expect(result.scannedBytes).toBe(8 * MiB);
  });

  it("marks a parser-rejected nested box as an invalid container", async () => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 16);
    bytes.set(new TextEncoder().encode("moov"), 4);
    view.setUint32(8, 4);
    bytes.set(new TextEncoder().encode("trak"), 12);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await preflightMp4(new Blob([bytes], { type: "video/mp4" }));

      expect(result.code).toBe("invalid_container");
      expect(result.scannedBytes).toBe(16);
    } finally {
      consoleLog.mockRestore();
      consoleWarn.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("rejects an aborted preflight instead of returning a stale result", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      preflightMp4(new Blob([new Uint8Array(32)]), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("marks an empty MP4 as a review item without invoking the parser", async () => {
    const result = await preflightMp4(new Blob([], { type: "video/mp4" }));

    expect(result.code).toBe("empty_file");
    expect(result.scannedBytes).toBe(0);
  });
});
