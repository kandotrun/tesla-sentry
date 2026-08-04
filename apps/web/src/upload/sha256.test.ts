import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashStreamSource } from "./sha256";

function nodeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function streamFrom(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function sourceOf(chunks: readonly Uint8Array[]) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  return { size, stream: () => streamFrom(chunks) };
}

function randomBytes(length: number): Uint8Array {
  // jsdomのgetRandomValuesは1回65,536バイトまで。
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65536) {
    const chunk = new Uint8Array(Math.min(65536, length - offset));
    crypto.getRandomValues(chunk);
    bytes.set(chunk, offset);
  }
  return bytes;
}

describe("hashStreamSource", () => {
  it("matches node crypto for chunked content", async () => {
    const chunks = [randomBytes(1_000_003), randomBytes(7), randomBytes(512)];
    const concat = new Uint8Array(chunks.reduce((total, c) => total + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      concat.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const digest = await hashStreamSource(sourceOf(chunks));
    expect(digest).toBe(nodeSha256(concat));
  });

  it("hashes an empty source to the empty-string digest", async () => {
    const digest = await hashStreamSource(sourceOf([]));
    expect(digest).toBe(nodeSha256(new Uint8Array(0)));
  });

  it("reports progress with the number of bytes consumed", async () => {
    const seen: number[] = [];
    await hashStreamSource(sourceOf([new Uint8Array(10), new Uint8Array(20)]), {
      onProgress: (bytes) => seen.push(bytes),
    });
    expect(seen).toEqual([10, 30]);
  });

  it("aborts when the signal fires", async () => {
    const controller = new AbortController();
    let pulled = 0;
    const slow = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        pulled += 1;
        if (pulled === 1) {
          streamController.enqueue(new Uint8Array(4));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        streamController.enqueue(new Uint8Array(4));
        streamController.close();
      },
    });
    const timer = setTimeout(() => controller.abort(), 10);
    await expect(
      hashStreamSource({ size: 8, stream: () => slow }, { signal: controller.signal }),
    ).rejects.toThrow();
    clearTimeout(timer);
  });
});
