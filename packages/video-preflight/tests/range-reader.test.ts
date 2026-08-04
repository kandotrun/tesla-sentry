import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type PreflightRangeReader,
  preflightMp4,
  preflightRangeReader,
  type VideoPreflightResult,
} from "../src/index";

interface RecordingReader {
  readonly reader: PreflightRangeReader;
  readonly calls: readonly { offset: number; length: number }[];
  readonly bytesRead: number;
}

function memoryReader(bytes: Uint8Array<ArrayBuffer>): RecordingReader {
  const calls: { offset: number; length: number }[] = [];
  let bytesRead = 0;
  const reader: PreflightRangeReader = {
    size: bytes.byteLength,
    async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
      if (offset < 0 || length < 1 || offset + length > bytes.byteLength) {
        throw new Error(`read out of range: ${offset}+${length}`);
      }
      calls.push({ offset, length });
      bytesRead += length;
      return bytes.slice(offset, offset + length);
    },
  };
  return {
    reader,
    calls,
    get bytesRead() {
      return bytesRead;
    },
  };
}

async function syntheticAvc(): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await readFile(new URL("./fixtures/one-second-avc.mp4", import.meta.url));
  return Uint8Array.from(bytes);
}

describe("preflightRangeReader", () => {
  it("produces the same result as preflightMp4 for the synthetic fixture", async () => {
    const bytes = await syntheticAvc();
    const recording = memoryReader(bytes);
    const fromBlob = await preflightMp4(new Blob([bytes]));
    const fromReader = await preflightRangeReader(recording.reader);
    expect(fromReader).toEqual(fromBlob);
    expect(fromReader.code).toBe("ready");
    expect(fromReader.durationSeconds).toBeGreaterThan(0);
  });

  it("classifies an empty reader as empty_file", async () => {
    const recording = memoryReader(new Uint8Array(0));
    const result = await preflightRangeReader(recording.reader);
    expect(result.code).toBe("empty_file");
    expect(recording.calls).toHaveLength(0);
  });

  it("classifies random bytes as invalid_container", async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => (index * 7) % 251);
    const recording = memoryReader(bytes);
    const result = await preflightRangeReader(recording.reader);
    expect(result.code).toBe("invalid_container");
  });

  it("reports metadata_not_found when the file has no moov box", async () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 24);
    bytes.set(new TextEncoder().encode("free"), 4);
    const recording = memoryReader(bytes);
    const result = await preflightRangeReader(recording.reader);
    expect(result.code).toBe("metadata_not_found");
  });

  it("keeps reads within the configured metadata budget", async () => {
    const bytes = await syntheticAvc();
    const recording = memoryReader(bytes);
    const result = await preflightRangeReader(recording.reader, { maxMetadataBytes: 64 });
    expect(result.code).toBe("metadata_not_found");
    expect(recording.bytesRead).toBeLessThanOrEqual(64);
  });

  it("reads chunks no larger than the configured chunk size", async () => {
    const bytes = await syntheticAvc();
    const recording = memoryReader(bytes);
    await preflightRangeReader(recording.reader, { chunkBytes: 64 });
    expect(recording.calls.length).toBeGreaterThan(1);
    for (const call of recording.calls) {
      expect(call.length).toBeLessThanOrEqual(64);
    }
  });

  it("rejects an already-aborted signal before reading", async () => {
    const bytes = await syntheticAvc();
    const recording = memoryReader(bytes);
    const controller = new AbortController();
    controller.abort();
    await expect(
      preflightRangeReader(recording.reader, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(recording.calls).toHaveLength(0);
  });

  it("rejects invalid reader sizes", async () => {
    const brokenReader: PreflightRangeReader = {
      size: Number.NaN,
      async read() {
        return new Uint8Array(0);
      },
    };
    await expect(preflightRangeReader(brokenReader)).rejects.toThrow();
  });

  it("surfaces truncation when the base reader returns short chunks", async () => {
    const bytes = await syntheticAvc();
    const shortReader: PreflightRangeReader = {
      size: bytes.byteLength,
      async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
        return bytes.slice(offset, offset + Math.min(length, 2));
      },
    };
    const result = await preflightRangeReader(shortReader);
    expect(result.code).toBe("invalid_container");
  });
});

describe("preflightMp4 regression parity", () => {
  it("keeps the Blob entry point byte-identical for adversarial budgets", async () => {
    const bytes = await syntheticAvc();
    const results: VideoPreflightResult[] = [];
    for (const maxMetadataBytes of [1, 2, 3, 5, 8, 16, 4096]) {
      results.push(await preflightMp4(new Blob([bytes]), { maxMetadataBytes }));
    }
    expect(results.map((result) => result.code)).toEqual([
      "metadata_not_found",
      "metadata_not_found",
      "metadata_not_found",
      "metadata_not_found",
      "metadata_not_found",
      "metadata_not_found",
      "ready",
    ]);
  });
});
