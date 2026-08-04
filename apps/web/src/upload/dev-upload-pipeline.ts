import {
  DEV_MAX_JOB_BYTES,
  DEV_MAX_JOB_FILES,
  type JobAcceptedFile,
  type SessionRejection,
} from "@sentry-check/upload-session";
import type { VideoPreflightResult } from "@sentry-check/video-preflight";

export type UploadEligibilityStatus = "eligible" | "pending" | "blocked";

export interface PlanInputFile {
  readonly eventId: string;
  readonly fingerprint: string;
  readonly name: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly status: UploadEligibilityStatus;
}

export interface DevUploadJobPlan {
  readonly files: readonly PlanInputFile[];
}

export function batchDevUploadFiles<T extends { readonly size: number }>(
  files: readonly T[],
): readonly (readonly T[])[] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const file of files) {
    if (
      current.length > 0 &&
      (current.length >= DEV_MAX_JOB_FILES || currentBytes + file.size > DEV_MAX_JOB_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

export interface JobFileRequest {
  readonly eventId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
}

export interface CreateJobResponse {
  readonly accepted: readonly JobAcceptedFile[];
  readonly expiresAtMs: number;
  readonly jobId: string;
  readonly jobToken: string;
  readonly rejected: readonly SessionRejection[];
}

export interface ApiTransport {
  readonly createJob: (request: { files: readonly JobFileRequest[] }) => Promise<CreateJobResponse>;
}

export interface PlannedJob {
  readonly acceptedFileIds: readonly string[];
  readonly expiresAtMs: number;
  readonly jobId: string;
  readonly jobToken: string;
}

/**
 * 開発環境ジョブの作成までを行う。eligible項目だけを選び、
 * サーバーが拒否したファイルがあればfail-closedで失敗する。
 */
export async function planDevUploadJob(
  plan: DevUploadJobPlan,
  transport: ApiTransport,
): Promise<PlannedJob> {
  const eligible = plan.files.filter((file) => file.status === "eligible");
  if (eligible.length === 0) {
    throw new Error("no eligible clips to upload");
  }
  // 開発環境ジョブのsha256は呼び出し側（ブラウザ）がアップロード前に計算して渡す。
  const files: JobFileRequest[] = eligible.map((file) => ({
    eventId: file.eventId,
    relativePath: file.relativePath,
    sha256: file.sha256,
    size: file.size,
  }));
  const response = await transport.createJob({ files });
  if (response.rejected.length > 0) {
    const first = response.rejected[0];
    throw new Error(`server rejected file index ${first?.index}: ${first?.code}`);
  }
  return {
    acceptedFileIds: response.accepted.map((file) => file.fileId),
    expiresAtMs: response.expiresAtMs,
    jobId: response.jobId,
    jobToken: response.jobToken,
  };
}

export type FileUploadPhase =
  | "waiting"
  | "hashing"
  | "uploading"
  | "verifying"
  | "verified"
  | "failed";

export interface FileUploadState {
  readonly bytesSent: number;
  readonly fileId: string;
  readonly name: string;
  readonly phase: FileUploadPhase;
  readonly reason: string | null;
  readonly size: number;
}

export interface VerifyResult {
  readonly preflight: VideoPreflightResult;
  readonly status: "verified";
}

export interface VerifyFailure {
  readonly reason: string;
  readonly status: "failed";
}

export interface GrantResponse {
  readonly expiresAtMs: number;
  readonly uploadToken: string;
}

export interface UploadTransport {
  readonly grant: (jobId: string, jobToken: string, fileId: string) => Promise<GrantResponse>;
  readonly put: (uploadToken: string, file: Blob, size: number) => Promise<void>;
  readonly verify: (jobId: string, jobToken: string, fileId: string) => Promise<VerifyResult>;
}

export interface DevUploader {
  readonly hash: (file: Blob, size: number) => Promise<string>;
}
