import { preflightMp4, type VideoPreflightResult } from "@sentry-check/video-preflight";

const PREFLIGHT_CONCURRENCY = 2;

export interface ClipFileInput {
  readonly file: File;
  readonly fingerprint: string;
}

export interface ClipPreflightRecord {
  readonly fingerprint: string;
  readonly name: string;
  readonly result: VideoPreflightResult;
}

export interface ClipPreflightState {
  readonly completed: number;
  readonly records: readonly ClipPreflightRecord[];
  readonly total: number;
}

export type ClipPreflightProbe = (file: File, signal: AbortSignal) => Promise<VideoPreflightResult>;

export const defaultClipPreflightProbe: ClipPreflightProbe = (file, signal) =>
  preflightMp4(file, { signal });

function unavailableResult(): VideoPreflightResult {
  return {
    code: "metadata_not_found",
    codec: null,
    durationSeconds: null,
    encrypted: false,
    height: null,
    scannedBytes: 0,
    width: null,
  };
}

export async function preflightClipFiles(
  clips: readonly ClipFileInput[],
  probe: ClipPreflightProbe,
  signal: AbortSignal,
  onResult: (record: ClipPreflightRecord) => void,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(PREFLIGHT_CONCURRENCY, clips.length);

  async function worker() {
    while (nextIndex < clips.length) {
      signal.throwIfAborted();
      const clip = clips[nextIndex];
      nextIndex += 1;
      if (!clip) {
        return;
      }

      let result: VideoPreflightResult;
      try {
        result = await probe(clip.file, signal);
      } catch {
        signal.throwIfAborted();
        result = unavailableResult();
      }
      signal.throwIfAborted();
      onResult({
        fingerprint: clip.fingerprint,
        name: clip.file.name,
        result,
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
