/**
 * sentry-check API Worker（開発環境専用）
 *
 * 開発環境のローカルR2への直接アップロードとサーバー側再検証を提供する。
 * 設計書: docs/DEV_DIRECT_UPLOAD.md
 *
 * - 大きな動画本文をバッファせず、R2バインディングへそのままストリーミングする
 * - ブラウザの適格判定を信頼せず、認可・サイズ・暗号学的ハッシュ・コンテナ内容を再検証する
 * - request固有の状態をmodule globalに持たない
 */
import {
  createJobToken,
  DEV_MAX_JOB_FILES,
  extractBearerToken,
  issueUploadToken,
  type JobFileInput,
  type JobTokenFile,
  type JobTokenPayload,
  StreamingSha256,
  UPLOAD_TOKEN_TTL_MS,
  validateJobId,
  verifyJobTokenDetailed,
  verifyUploadTokenDetailed,
} from "@sentry-check/upload-session";
import {
  type PreflightRangeReader,
  preflightRangeReader,
  type VideoPreflightResult,
} from "@sentry-check/video-preflight";

export interface Env {
  readonly BUCKET: R2Bucket;
  readonly DEV_UPLOAD_SECRET?: string;
}

const JOB_TTL_MS = 3_600_000;
const HEX32_PATTERN = /^[0-9a-f]{32}$/;

type VerifyFailureReason =
  | "object_missing"
  | "object_changed"
  | "size_mismatch"
  | "hash_mismatch"
  | "container_not_ready";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function apiError(status: number, code: string): Response {
  return jsonResponse(status, { error: { code } });
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function randomJobId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function sha256HexOfStream(stream: ReadableStream): Promise<string> {
  // workerdローカル（miniflare）にはDigestStreamが公開されていないため、
  // 依存なしのincremental実装でR2オブジェクトをチャンク単位にハッシュする。
  const hasher = new StreamingSha256();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      hasher.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return hasher.digestHex();
}

function requireSecret(env: Env): string | null {
  return typeof env.DEV_UPLOAD_SECRET === "string" && env.DEV_UPLOAD_SECRET.length > 0
    ? env.DEV_UPLOAD_SECRET
    : null;
}

class R2PreflightReader implements PreflightRangeReader {
  readonly size: number;
  private readonly bucket: R2Bucket;
  private readonly key: string;
  private readonly etag: string;

  constructor(bucket: R2Bucket, key: string, size: number, etag: string) {
    this.bucket = bucket;
    this.etag = etag;
    this.key = key;
    this.size = size;
  }

  async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    if (offset >= this.size || length <= 0) {
      return new Uint8Array(new ArrayBuffer(0));
    }
    const object = await this.bucket.get(this.key, {
      onlyIf: { etagMatches: this.etag },
      range: { length, offset },
    });
    if (object === null || !("body" in object)) {
      return new Uint8Array(new ArrayBuffer(0));
    }
    const buffer = await object.arrayBuffer();
    return new Uint8Array(buffer);
  }
}

function isJobFileInput(value: unknown): value is JobFileInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.relativePath === "string" &&
    typeof candidate.sha256 === "string" &&
    typeof candidate.size === "number"
  );
}

async function parseJobFiles(request: Request): Promise<JobFileInput[] | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const files = (body as Record<string, unknown>).files;
  if (!Array.isArray(files) || files.length > DEV_MAX_JOB_FILES) {
    return null;
  }
  if (!files.every(isJobFileInput)) {
    return null;
  }
  return files;
}

async function handleCreateJob(request: Request, secret: string): Promise<Response> {
  const files = await parseJobFiles(request);
  if (!files) {
    return apiError(400, "invalid_request");
  }
  const jobId = randomJobId();
  const nowMs = Date.now();
  const expiresAtMs = nowMs + JOB_TTL_MS;
  const result = await createJobToken(jobId, files, secret, { nowMs, expiresAtMs });
  if (result.code === "contract_violation") {
    return apiError(400, "contract_violation");
  }
  return jsonResponse(201, {
    accepted: result.accepted,
    expiresAtMs: result.expiresAtMs,
    jobId,
    jobToken: result.jobToken,
    rejected: result.rejected,
  });
}

type AuthenticatedJob = { response: Response } | { jobToken: string; payload: JobTokenPayload };

async function authenticateJob(
  request: Request,
  secret: string,
  jobId: string,
): Promise<AuthenticatedJob> {
  const jobToken = extractBearerToken(request.headers.get("authorization"));
  if (jobToken === null) {
    return { response: apiError(401, "missing_token") };
  }
  const verification = await verifyJobTokenDetailed(jobToken, secret, Date.now());
  if (verification.status === "invalid") {
    return { response: apiError(401, "invalid_token") };
  }
  if (verification.status === "expired") {
    return { response: apiError(401, "expired_token") };
  }
  if (verification.payload.jobId !== jobId) {
    return { response: apiError(403, "job_mismatch") };
  }
  return { jobToken, payload: verification.payload };
}

async function parseGrantBody(request: Request): Promise<string | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const fileId = (body as Record<string, unknown>).fileId;
  return typeof fileId === "string" && HEX32_PATTERN.test(fileId) ? fileId : null;
}

async function handleGrant(request: Request, secret: string, jobId: string): Promise<Response> {
  const auth = await authenticateJob(request, secret, jobId);
  if ("response" in auth) {
    return auth.response;
  }
  const fileId = await parseGrantBody(request);
  if (fileId === null) {
    return apiError(400, "invalid_request");
  }
  const file = auth.payload.files.find((candidate) => candidate.fileId === fileId);
  if (!file) {
    return apiError(404, "unknown_file");
  }
  const uploadToken = await issueUploadToken(auth.jobToken, fileId, secret, Date.now());
  if (uploadToken === null) {
    return apiError(401, "invalid_token");
  }
  return jsonResponse(200, {
    expiresAtMs: Date.now() + UPLOAD_TOKEN_TTL_MS,
    uploadToken,
  });
}

async function handleUpload(request: Request, env: Env, secret: string): Promise<Response> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (token === null) {
    return apiError(401, "missing_token");
  }
  const verification = await verifyUploadTokenDetailed(token, secret, Date.now());
  if (verification.status === "invalid") {
    return apiError(401, "invalid_token");
  }
  if (verification.status === "expired") {
    return apiError(401, "expired_token");
  }
  const payload = verification.payload;

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength !== payload.size) {
      return apiError(400, "content_length_mismatch");
    }
  }
  if (request.body === null) {
    return apiError(400, "content_length_mismatch");
  }

  // 失敗した再送が検証済みfinal objectを壊さないよう、一意なstaging keyへ
  // 固定長で完走してからfinal keyへpromotionする。
  const stagingKey = `dev/staging/${payload.jobId}/${payload.fileId}/${crypto.randomUUID()}`;
  const lengthStream = new FixedLengthStream(payload.size);
  const transferResults = await Promise.allSettled([
    request.body.pipeTo(lengthStream.writable),
    env.BUCKET.put(stagingKey, lengthStream.readable),
  ]);
  if (transferResults.some((result) => result.status === "rejected")) {
    await env.BUCKET.delete(stagingKey);
    return apiError(400, "content_length_mismatch");
  }
  const staged = await env.BUCKET.get(stagingKey);
  if (staged === null || !("body" in staged) || staged.size !== payload.size) {
    await env.BUCKET.delete(stagingKey);
    return apiError(500, "upload_failed");
  }
  try {
    await env.BUCKET.put(payload.key, staged.body, {
      customMetadata: {
        uploadedAt: new Date().toISOString(),
      },
    });
  } finally {
    await env.BUCKET.delete(stagingKey);
  }
  return jsonResponse(200, { key: payload.key, ok: true, size: payload.size });
}

async function verifyStoredFile(
  env: Env,
  file: JobTokenFile,
): Promise<
  | { status: "verified"; preflight: VideoPreflightResult }
  | { status: "failed"; reason: VerifyFailureReason }
> {
  const object = await env.BUCKET.get(file.key);
  if (object === null || !("body" in object)) {
    return { status: "failed", reason: "object_missing" };
  }
  if (object.size !== file.size) {
    await env.BUCKET.delete(file.key);
    return { status: "failed", reason: "size_mismatch" };
  }
  const digestHex = await sha256HexOfStream(object.body);
  if (digestHex !== file.sha256) {
    await env.BUCKET.delete(file.key);
    return { status: "failed", reason: "hash_mismatch" };
  }
  const reader = new R2PreflightReader(env.BUCKET, file.key, object.size, object.etag);
  const preflight = await preflightRangeReader(reader);
  if (preflight.code !== "ready") {
    await env.BUCKET.delete(file.key);
    return { status: "failed", reason: "container_not_ready" };
  }
  const stored = await env.BUCKET.get(file.key, { onlyIf: { etagMatches: object.etag } });
  if (stored === null || !("body" in stored)) {
    return { status: "failed", reason: "object_changed" };
  }
  const committed = await env.BUCKET.put(file.key, stored.body, {
    customMetadata: {
      ...(stored.customMetadata ?? {}),
      preflight: preflight.code,
      verified: "1",
      verifiedAt: new Date().toISOString(),
    },
    onlyIf: { etagMatches: object.etag },
    ...(stored.httpMetadata !== undefined ? { httpMetadata: stored.httpMetadata } : {}),
  });
  if (committed === null) {
    return { status: "failed", reason: "object_changed" };
  }
  return { status: "verified", preflight };
}

async function handleVerify(
  request: Request,
  env: Env,
  secret: string,
  jobId: string,
  fileId: string,
): Promise<Response> {
  const auth = await authenticateJob(request, secret, jobId);
  if ("response" in auth) {
    return auth.response;
  }
  const file = auth.payload.files.find((candidate) => candidate.fileId === fileId);
  if (!file) {
    return apiError(404, "unknown_file");
  }
  const result = await verifyStoredFile(env, file);
  if (result.status === "failed") {
    return jsonResponse(200, { reason: result.reason, status: "failed" });
  }
  return jsonResponse(200, {
    fileId: file.fileId,
    key: file.key,
    preflight: result.preflight,
    sha256: file.sha256,
    size: file.size,
    status: "verified",
  });
}

interface StatusFile {
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

async function handleStatus(
  request: Request,
  env: Env,
  secret: string,
  jobId: string,
): Promise<Response> {
  const auth = await authenticateJob(request, secret, jobId);
  if ("response" in auth) {
    return auth.response;
  }
  const files: StatusFile[] = [];
  for (const file of auth.payload.files) {
    const head = await env.BUCKET.head(file.key);
    const metadata = head?.customMetadata ?? {};
    files.push({
      eventId: file.eventId,
      fileId: file.fileId,
      key: file.key,
      preflightCode: metadata.preflight ?? null,
      sha256: file.sha256,
      size: file.size,
      uploaded: head !== null,
      verified: metadata.verified === "1",
      verifiedAt: metadata.verifiedAt ?? null,
    });
  }
  return jsonResponse(200, { files, jobId });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env);
    } catch {
      return apiError(500, "internal");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const secret = requireSecret(env);
  if (secret === null) {
    return apiError(503, "secret_not_configured");
  }
  if (!path.startsWith("/api/dev/")) {
    return apiError(404, "not_found");
  }
  const segments = path.slice("/api/dev/".length).split("/");

  if (request.method === "POST" && segments.length === 1 && segments[0] === "jobs") {
    return handleCreateJob(request, secret);
  }
  if (request.method === "PUT" && segments.length === 1 && segments[0] === "upload") {
    return handleUpload(request, env, secret);
  }
  if (
    segments.length === 3 &&
    segments[0] === "jobs" &&
    typeof segments[1] === "string" &&
    validateJobId(segments[1])
  ) {
    const jobId = segments[1];
    if (request.method === "POST" && segments[2] === "grant") {
      return handleGrant(request, secret, jobId);
    }
    if (request.method === "GET" && segments[2] === "status") {
      return handleStatus(request, env, secret, jobId);
    }
  }
  if (
    request.method === "POST" &&
    segments.length === 4 &&
    segments[0] === "jobs" &&
    typeof segments[1] === "string" &&
    validateJobId(segments[1]) &&
    segments[2] === "verify" &&
    typeof segments[3] === "string" &&
    HEX32_PATTERN.test(segments[3])
  ) {
    return handleVerify(request, env, secret, segments[1], segments[3]);
  }
  return apiError(404, "not_found");
}
