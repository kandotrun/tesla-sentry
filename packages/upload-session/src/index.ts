/**
 * upload-session v1（開発環境用アップロードセッション契約）
 *
 * 開発環境のR2直接アップロードで使う、純粋でネットワーク非依存の契約。
 * ブラウザとWorkerの両方で同じ検証規則とトークン形式を使う。
 * 設計書: docs/DEV_DIRECT_UPLOAD.md
 */

export const UPLOAD_SESSION_SCHEMA_VERSION = 1;

/** 開発環境の上限。1ファイル2GB、1ジョブ20GB、12ファイル。 */
export const DEV_MAX_FILE_BYTES = 2_147_483_648;
export const DEV_MAX_JOB_BYTES = 21_474_836_480;
export const DEV_MAX_JOB_FILES = 12;
export const DEV_MAX_RELATIVE_PATH_CHARS = 256;
export const DEV_MAX_OBJECT_KEY_CHARS = 512;
export const DEV_MAX_JOB_TOKEN_BYTES = 12 * 1024;
/** アップロードトークンの有効期間（5分）。 */
export const UPLOAD_TOKEN_TTL_MS = 300_000;

export type SessionRejectionCode =
  | "invalid_path"
  | "invalid_size"
  | "invalid_sha256"
  | "file_size_exceeded"
  | "too_many_files"
  | "job_size_exceeded"
  | "duplicate_file";

export interface SessionFileInput {
  readonly eventId: string;
  readonly relativePath: string;
  readonly size: number;
}

export interface SessionFile {
  readonly fileId: string;
  readonly eventId: string;
  readonly relativePath: string;
  readonly key: string;
  readonly size: number;
}

export interface SessionRejection {
  readonly index: number;
  readonly code: SessionRejectionCode;
}

export interface SessionValidationResult {
  readonly accepted: readonly SessionFile[];
  readonly rejected: readonly SessionRejection[];
}

export interface JobFileInput {
  readonly eventId: string;
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
}

export interface JobAcceptedFile extends SessionFile {
  readonly sha256: string;
}

export type CreateJobTokenResult =
  | { readonly code: "contract_violation"; readonly reason: string }
  | {
      readonly code: "ok";
      readonly jobToken: string;
      readonly expiresAtMs: number;
      readonly accepted: readonly JobAcceptedFile[];
      readonly rejected: readonly SessionRejection[];
    };

export interface JobTokenFile {
  readonly fileId: string;
  readonly eventId: string;
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
}

export interface JobTokenPayload {
  readonly v: 1;
  readonly t: "job";
  readonly jobId: string;
  readonly iat: number;
  readonly exp: number;
  readonly files: readonly JobTokenFile[];
}

export interface UploadTokenPayload {
  readonly v: 1;
  readonly t: "upload";
  readonly jobId: string;
  readonly fileId: string;
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
  readonly iat: number;
  readonly exp: number;
}

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const HEX32_PATTERN = /^[0-9a-f]{32}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
}

async function hmacSign(payload: Uint8Array, secret: string): Promise<Uint8Array> {
  const copied = new Uint8Array(payload);
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), copied);
  return new Uint8Array(signature);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.byteLength; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function isSafeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 128 &&
    segment !== "." &&
    segment !== ".." &&
    SAFE_SEGMENT_PATTERN.test(segment)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validateJobId(jobId: string): boolean {
  return typeof jobId === "string" && /^[0-9a-f]{64}$/.test(jobId);
}

export function validateSha256(digest: string): boolean {
  return typeof digest === "string" && HEX64_PATTERN.test(digest);
}

export function sanitizePathSegments(relativePath: string): readonly string[] | null {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.length > DEV_MAX_RELATIVE_PATH_CHARS
  ) {
    return null;
  }
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (!isSafeSegment(segment)) {
      return null;
    }
  }
  return segments;
}

export function deriveObjectKey(
  jobId: string,
  eventId: string,
  relativePath: string,
): string | null {
  if (!validateJobId(jobId) || !isSafeSegment(eventId)) {
    return null;
  }
  const segments = sanitizePathSegments(relativePath);
  if (!segments) {
    return null;
  }
  const key = `dev/jobs/${jobId}/${eventId}/${segments.join("/")}`;
  return key.length <= DEV_MAX_OBJECT_KEY_CHARS ? key : null;
}

export function isValidObjectKey(key: string, jobId: string): boolean {
  if (typeof key !== "string" || key.length > DEV_MAX_OBJECT_KEY_CHARS || !validateJobId(jobId)) {
    return false;
  }
  const prefix = `dev/jobs/${jobId}/`;
  if (!key.startsWith(prefix)) {
    return false;
  }
  const remainder = key.slice(prefix.length);
  const segments = remainder.split("/");
  if (segments.length < 2) {
    return false;
  }
  return segments.every((segment) => isSafeSegment(segment));
}

export async function deriveFileId(eventId: string, relativePath: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(`${eventId}\u0000${relativePath}`),
  );
  return toHex(new Uint8Array(digest).slice(0, 16));
}

export async function validateSessionFiles(
  jobId: string,
  inputs: readonly SessionFileInput[],
): Promise<SessionValidationResult> {
  if (!validateJobId(jobId)) {
    throw new Error("Invalid job id");
  }

  const accepted: SessionFile[] = [];
  const rejected: SessionRejection[] = [];
  const seenKeys = new Set<string>();
  let acceptedFiles = 0;
  let totalBytes = 0;

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (!input) {
      continue;
    }
    if (acceptedFiles >= DEV_MAX_JOB_FILES) {
      rejected.push({ code: "too_many_files", index });
      continue;
    }
    if (!isSafeSegment(input.eventId) || !sanitizePathSegments(input.relativePath)) {
      rejected.push({ code: "invalid_path", index });
      continue;
    }
    if (!isPositiveSafeInteger(input.size)) {
      rejected.push({ code: "invalid_size", index });
      continue;
    }
    if (input.size > DEV_MAX_FILE_BYTES) {
      rejected.push({ code: "file_size_exceeded", index });
      continue;
    }
    if (totalBytes + input.size > DEV_MAX_JOB_BYTES) {
      rejected.push({ code: "job_size_exceeded", index });
      continue;
    }
    const key = deriveObjectKey(jobId, input.eventId, input.relativePath);
    if (!key || seenKeys.has(key)) {
      rejected.push({ code: "duplicate_file", index });
      continue;
    }
    seenKeys.add(key);
    totalBytes += input.size;
    acceptedFiles += 1;
    accepted.push({
      eventId: input.eventId,
      fileId: await deriveFileId(input.eventId, input.relativePath),
      key,
      relativePath: input.relativePath,
      size: input.size,
    });
  }

  return { accepted, rejected };
}

export async function encodeSignedPayload(payload: unknown, secret: string): Promise<string> {
  const payloadBytes = textEncoder.encode(JSON.stringify(payload));
  const signature = await hmacSign(payloadBytes, secret);
  return `${toBase64Url(payloadBytes)}.${toBase64Url(signature)}`;
}

export async function decodeSignedPayload<T = unknown>(
  token: string,
  secret: string,
): Promise<T | null> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    return null;
  }
  const separatorIndex = token.indexOf(".");
  const payloadPart = token.slice(0, separatorIndex);
  const signaturePart = token.slice(separatorIndex + 1);
  if (signaturePart.includes(".")) {
    return null;
  }
  const payloadBytes = fromBase64Url(payloadPart);
  const signatureBytes = fromBase64Url(signaturePart);
  if (!payloadBytes || !signatureBytes) {
    return null;
  }
  const expectedSignature = await hmacSign(payloadBytes, secret);
  if (!constantTimeEqual(expectedSignature, signatureBytes)) {
    return null;
  }
  try {
    return JSON.parse(textDecoder.decode(payloadBytes)) as T;
  } catch {
    return null;
  }
}

function validateJobTokenFiles(files: unknown): files is JobTokenFile[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > DEV_MAX_JOB_FILES) {
    return false;
  }
  const seenKeys = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (typeof file !== "object" || file === null) {
      return false;
    }
    const candidate = file as Record<string, unknown>;
    if (
      typeof candidate.fileId !== "string" ||
      !HEX32_PATTERN.test(candidate.fileId) ||
      typeof candidate.eventId !== "string" ||
      !isSafeSegment(candidate.eventId) ||
      typeof candidate.key !== "string" ||
      !isPositiveSafeInteger(candidate.size) ||
      candidate.size > DEV_MAX_FILE_BYTES ||
      typeof candidate.sha256 !== "string" ||
      !HEX64_PATTERN.test(candidate.sha256)
    ) {
      return false;
    }
    totalBytes += candidate.size;
    if (totalBytes > DEV_MAX_JOB_BYTES) {
      return false;
    }
    if (seenKeys.has(candidate.key)) {
      return false;
    }
    seenKeys.add(candidate.key);
  }
  return true;
}

export async function verifyJobToken(
  token: string,
  secret: string,
  nowMs: number,
): Promise<JobTokenPayload | null> {
  const detailed = await verifyJobTokenDetailed(token, secret, nowMs);
  return detailed.status === "ok" ? detailed.payload : null;
}

export type TokenVerificationStatus = "ok" | "expired" | "invalid";

export type JobTokenVerificationResult =
  | { readonly status: "ok"; readonly payload: JobTokenPayload }
  | { readonly status: "expired" }
  | { readonly status: "invalid" };

export type UploadTokenVerificationResult =
  | { readonly status: "ok"; readonly payload: UploadTokenPayload }
  | { readonly status: "expired" }
  | { readonly status: "invalid" };

async function verifyJobTokenStructure(
  token: string,
  secret: string,
): Promise<JobTokenPayload | null> {
  const payload = await decodeSignedPayload<Record<string, unknown>>(token, secret);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (
    payload.v !== 1 ||
    payload.t !== "job" ||
    typeof payload.jobId !== "string" ||
    !validateJobId(payload.jobId) ||
    !isNonNegativeSafeInteger(payload.iat) ||
    !isNonNegativeSafeInteger(payload.exp) ||
    !validateJobTokenFiles(payload.files)
  ) {
    return null;
  }
  const files = payload.files;
  for (const file of files) {
    if (!isValidObjectKey(file.key, payload.jobId)) {
      return null;
    }
  }
  return {
    exp: payload.exp,
    files,
    iat: payload.iat,
    jobId: payload.jobId,
    t: "job",
    v: 1,
  };
}

export async function verifyJobTokenDetailed(
  token: string,
  secret: string,
  nowMs: number,
): Promise<JobTokenVerificationResult> {
  const payload = await verifyJobTokenStructure(token, secret);
  if (!payload) {
    return { status: "invalid" };
  }
  if (payload.exp <= nowMs) {
    return { status: "expired" };
  }
  return { status: "ok", payload };
}

export async function issueUploadToken(
  jobToken: string,
  fileId: string,
  secret: string,
  nowMs: number,
): Promise<string | null> {
  const jobPayload = await verifyJobToken(jobToken, secret, nowMs);
  if (!jobPayload) {
    return null;
  }
  const file = jobPayload.files.find((candidate) => candidate.fileId === fileId);
  if (!file) {
    return null;
  }
  const uploadPayload: UploadTokenPayload = {
    exp: nowMs + UPLOAD_TOKEN_TTL_MS,
    fileId: file.fileId,
    iat: nowMs,
    jobId: jobPayload.jobId,
    key: file.key,
    sha256: file.sha256,
    size: file.size,
    t: "upload",
    v: 1,
  };
  return encodeSignedPayload(uploadPayload, secret);
}

async function verifyUploadTokenStructure(
  token: string,
  secret: string,
): Promise<UploadTokenPayload | null> {
  const payload = await decodeSignedPayload<Record<string, unknown>>(token, secret);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (
    payload.v !== 1 ||
    payload.t !== "upload" ||
    typeof payload.jobId !== "string" ||
    !validateJobId(payload.jobId) ||
    typeof payload.fileId !== "string" ||
    !HEX32_PATTERN.test(payload.fileId) ||
    typeof payload.key !== "string" ||
    !isValidObjectKey(payload.key, payload.jobId) ||
    !isPositiveSafeInteger(payload.size) ||
    payload.size > DEV_MAX_FILE_BYTES ||
    typeof payload.sha256 !== "string" ||
    !HEX64_PATTERN.test(payload.sha256) ||
    !isNonNegativeSafeInteger(payload.iat) ||
    !isNonNegativeSafeInteger(payload.exp)
  ) {
    return null;
  }
  return {
    exp: payload.exp,
    fileId: payload.fileId,
    iat: payload.iat,
    jobId: payload.jobId,
    key: payload.key,
    sha256: payload.sha256,
    size: payload.size,
    t: "upload",
    v: 1,
  };
}

export async function verifyUploadTokenDetailed(
  token: string,
  secret: string,
  nowMs: number,
): Promise<UploadTokenVerificationResult> {
  const payload = await verifyUploadTokenStructure(token, secret);
  if (!payload) {
    return { status: "invalid" };
  }
  if (payload.exp <= nowMs) {
    return { status: "expired" };
  }
  return { status: "ok", payload };
}

export async function verifyUploadToken(
  token: string,
  secret: string,
  nowMs: number,
): Promise<UploadTokenPayload | null> {
  const detailed = await verifyUploadTokenDetailed(token, secret, nowMs);
  return detailed.status === "ok" ? detailed.payload : null;
}

export function extractBearerToken(header: string | null): string | null {
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return null;
  }
  const token = (match[1] ?? "").trim();
  return token.length > 0 ? token : null;
}

export async function createJobToken(
  jobId: string,
  files: readonly JobFileInput[],
  secret: string,
  options: { nowMs: number; expiresAtMs: number },
): Promise<CreateJobTokenResult> {
  const { nowMs, expiresAtMs } = options;
  if (!validateJobId(jobId)) {
    return { code: "contract_violation", reason: "invalid_job_id" };
  }
  if (files.length > DEV_MAX_JOB_FILES) {
    return { code: "contract_violation", reason: "too_many_files" };
  }

  const accepted: JobAcceptedFile[] = [];
  const rejected: SessionRejection[] = [];
  const seenKeys = new Set<string>();
  let totalBytes = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) {
      continue;
    }
    if (!validateSha256(file.sha256)) {
      rejected.push({ code: "invalid_sha256", index });
      continue;
    }
    if (!isSafeSegment(file.eventId) || !sanitizePathSegments(file.relativePath)) {
      rejected.push({ code: "invalid_path", index });
      continue;
    }
    if (!isPositiveSafeInteger(file.size)) {
      rejected.push({ code: "invalid_size", index });
      continue;
    }
    if (file.size > DEV_MAX_FILE_BYTES) {
      return { code: "contract_violation", reason: "file_size_exceeded" };
    }
    if (totalBytes + file.size > DEV_MAX_JOB_BYTES) {
      return { code: "contract_violation", reason: "job_size_exceeded" };
    }
    const key = deriveObjectKey(jobId, file.eventId, file.relativePath);
    if (!key || seenKeys.has(key)) {
      rejected.push({ code: "duplicate_file", index });
      continue;
    }
    seenKeys.add(key);
    totalBytes += file.size;
    accepted.push({
      eventId: file.eventId,
      fileId: await deriveFileId(file.eventId, file.relativePath),
      key,
      relativePath: file.relativePath,
      size: file.size,
      sha256: file.sha256,
    });
  }

  if (accepted.length === 0) {
    return { code: "contract_violation", reason: "no_accepted_files" };
  }

  const payload: JobTokenPayload = {
    v: 1,
    t: "job",
    jobId,
    iat: nowMs,
    exp: expiresAtMs,
    files: accepted.map(({ eventId, fileId, key, sha256, size }) => ({
      eventId,
      fileId,
      key,
      sha256,
      size,
    })),
  };
  const jobToken = await encodeSignedPayload(payload, secret);
  if (textEncoder.encode(jobToken).byteLength > DEV_MAX_JOB_TOKEN_BYTES) {
    return { code: "contract_violation", reason: "job_token_too_large" };
  }
  return { code: "ok", jobToken, expiresAtMs, accepted, rejected };
}

export { StreamingSha256 } from "./sha256";
