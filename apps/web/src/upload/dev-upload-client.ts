import type { VideoPreflightResult } from "@sentry-check/video-preflight";
import type { CreateJobResponse, GrantResponse } from "./dev-upload-pipeline";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string) {
    super(`dev api ${status}: ${code}`);
    this.code = code;
    this.status = status;
  }
}

interface ErrorBody {
  readonly error?: { readonly code?: string };
}

export interface VerifyResult {
  readonly fileId: string;
  readonly key: string;
  readonly preflight: VideoPreflightResult;
  readonly sha256: string;
  readonly size: number;
  readonly status: "verified";
}

export interface VerifyFailure {
  readonly reason: string;
  readonly status: "failed";
}

export interface StatusFile {
  readonly eventId: string;
  readonly fileId: string;
  readonly key: string;
  readonly preflightCode: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly uploaded: boolean;
  readonly verified: boolean;
  readonly verifiedAt: string | null;
}

export interface StatusResponse {
  readonly files: readonly StatusFile[];
  readonly jobId: string;
}

export interface DevApiClient {
  readonly createJob: (request: {
    readonly files: readonly {
      readonly eventId: string;
      readonly relativePath: string;
      readonly sha256: string;
      readonly size: number;
    }[];
  }) => Promise<CreateJobResponse>;
  readonly grant: (jobId: string, jobToken: string, fileId: string) => Promise<GrantResponse>;
  readonly upload: (
    uploadToken: string,
    body: Blob,
    onProgress: (bytesSent: number) => void,
  ) => Promise<void>;
  readonly verify: (
    jobId: string,
    jobToken: string,
    fileId: string,
  ) => Promise<VerifyResult | VerifyFailure>;
  readonly status: (jobId: string, jobToken: string) => Promise<StatusResponse>;
}

interface DevApiClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

async function parseError(response: Response): Promise<never> {
  let code = "http_error";
  try {
    const body = (await response.json()) as ErrorBody;
    if (typeof body.error?.code === "string") {
      code = body.error.code;
    }
  } catch {
    // 本文がJSONでない場合は汎用コードを使う
  }
  throw new ApiError(response.status, code);
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    await parseError(response);
  }
  return (await response.json()) as T;
}

export function createDevApiClient(options: DevApiClientOptions = {}): DevApiClient {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;

  async function upload(
    uploadToken: string,
    body: Blob,
    onProgress: (bytesSent: number) => void,
  ): Promise<void> {
    // fetchには信頼できる送信進捗がないため、PUT送信後に全バイト報告する。
    // 進捗バーの粒度改善はmultipart化（本番対応）のタイミングで行う。
    const response = await fetchImpl(`${baseUrl}/api/dev/upload`, {
      body,
      headers: {
        authorization: `Bearer ${uploadToken}`,
        "content-type": "video/mp4",
      },
      method: "PUT",
    });
    if (!response.ok) {
      await parseError(response);
    }
    onProgress(body.size);
  }

  return {
    async createJob(request) {
      const response = await fetchImpl(`${baseUrl}/api/dev/jobs`, {
        body: JSON.stringify(request),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return parseJson<CreateJobResponse>(response);
    },
    async grant(jobId, jobToken, fileId) {
      const response = await fetchImpl(`${baseUrl}/api/dev/jobs/${jobId}/grant`, {
        body: JSON.stringify({ fileId }),
        headers: {
          authorization: `Bearer ${jobToken}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      return parseJson<GrantResponse>(response);
    },
    upload,
    async verify(jobId, jobToken, fileId) {
      const response = await fetchImpl(`${baseUrl}/api/dev/jobs/${jobId}/verify/${fileId}`, {
        headers: { authorization: `Bearer ${jobToken}` },
        method: "POST",
      });
      return parseJson<VerifyResult | VerifyFailure>(response);
    },
    async status(jobId, jobToken) {
      const response = await fetchImpl(`${baseUrl}/api/dev/jobs/${jobId}/status`, {
        headers: { authorization: `Bearer ${jobToken}` },
        method: "GET",
      });
      return parseJson<StatusResponse>(response);
    },
  };
}
