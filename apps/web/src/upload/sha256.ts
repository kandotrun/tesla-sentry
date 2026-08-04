import { StreamingSha256 } from "@sentry-check/upload-session";

export interface StreamSource {
  readonly size: number;
  readonly stream: () => ReadableStream<Uint8Array>;
}

export interface HashProgress {
  readonly onProgress: (hashedBytes: number) => void;
}

export interface HashAbort {
  readonly signal: AbortSignal;
}

/**
 * Blob/File等のチャンクストリームをメモリに溜めずにSHA-256する。
 * `crypto.subtle.digest`は非ストリーミングのため、大きな動画には使えない。
 */
export async function hashStreamSource(
  source: StreamSource,
  options: Partial<HashProgress & HashAbort> = {},
): Promise<string> {
  const hasher = new StreamingSha256();
  const signal = options.signal;
  if (signal?.aborted) {
    signal.throwIfAborted();
  }
  let hashed = 0;
  const stream = source.stream();
  const reader = stream.getReader();
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        signal.throwIfAborted();
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      hasher.update(value);
      hashed += value.byteLength;
      options.onProgress?.(hashed);
    }
  } finally {
    reader.releaseLock();
  }
  if (hashed !== source.size) {
    throw new Error(`hash source size mismatch: declared ${source.size}, hashed ${hashed}`);
  }
  return hasher.digestHex();
}

/**
 * ブラウザのFileをStreamSourceとして扱う。
 * `File.stream()`は読み出しのたびに新しいストリームを作る。
 */
export function fileStreamSource(file: File): StreamSource {
  return {
    size: file.size,
    stream: () => file.stream() as ReadableStream<Uint8Array>,
  };
}
