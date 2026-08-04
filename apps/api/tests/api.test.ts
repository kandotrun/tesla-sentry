import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { encodeSignedPayload, type JobTokenPayload } from "@sentry-check/upload-session";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Unstable_DevWorker, unstable_dev } from "wrangler";

type DevResponse = Awaited<ReturnType<Unstable_DevWorker["fetch"]>>;

const DEV_SECRET = "dev-only-test-secret";
const EVENT_ID = "2026-08-03_12-34-56";

let worker: Unstable_DevWorker;
let fixtureBytes: Uint8Array<ArrayBuffer>;
let fixtureSha256: string;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface JobFile {
  readonly eventId: string;
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
}

interface ApiError {
  readonly error: { readonly code: string; readonly message?: string };
}

async function createJob(files: readonly JobFile[]): Promise<DevResponse> {
  return worker.fetch("/api/dev/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });
}

async function grant(jobId: string, jobToken: string, fileId: string): Promise<DevResponse> {
  return worker.fetch(`/api/dev/jobs/${jobId}/grant`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jobToken}`,
    },
    body: JSON.stringify({ fileId }),
  });
}

async function upload(
  uploadToken: string,
  body: Uint8Array | ReadableStream,
): Promise<DevResponse> {
  return worker.fetch("/api/dev/upload", {
    method: "PUT",
    headers: { authorization: `Bearer ${uploadToken}` },
    body,
    duplex: "half",
  });
}

async function verify(jobId: string, jobToken: string, fileId: string): Promise<DevResponse> {
  return worker.fetch(`/api/dev/jobs/${jobId}/verify/${fileId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jobToken}` },
  });
}

async function status(jobId: string, jobToken: string): Promise<DevResponse> {
  return worker.fetch(`/api/dev/jobs/${jobId}/status`, {
    headers: { authorization: `Bearer ${jobToken}` },
  });
}

beforeAll(async () => {
  const fixtureHref = new URL(
    "../../../packages/video-preflight/tests/fixtures/one-second-avc.mp4",
    import.meta.url,
  ).href;
  fixtureBytes = await readFile(fileURLToPath(fixtureHref)).then((buffer) =>
    Uint8Array.from(buffer),
  );
  fixtureSha256 = sha256Hex(fixtureBytes);
  worker = await unstable_dev("src/index.ts", {
    bundle: true,
    compatibilityDate: "2026-08-03",
    inspect: false,
    local: true,
    logLevel: "none",
    persist: false,
    vars: { DEV_UPLOAD_SECRET: DEV_SECRET },
    r2: [{ binding: "BUCKET", bucket_name: "dev-test-uploads" }],
  });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
});

describe("POST /api/dev/jobs", () => {
  it("creates a job with a signed job token and deterministic file ids", async () => {
    const response = await createJob([
      {
        eventId: EVENT_ID,
        relativePath: "SavedClips/front.mp4",
        size: 1000,
        sha256: "a".repeat(64),
      },
    ]);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      jobId: string;
      jobToken: string;
      expiresAtMs: number;
      accepted: { fileId: string; key: string; sha256: string }[];
      rejected: unknown[];
    };
    expect(body.jobId).toMatch(/^[0-9a-f]{64}$/);
    expect(body.jobToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.expiresAtMs).toBeGreaterThan(Date.now());
    expect(body.rejected).toEqual([]);
    expect(body.accepted).toHaveLength(1);
    expect(body.accepted[0]?.key).toBe(`dev/jobs/${body.jobId}/${EVENT_ID}/SavedClips/front.mp4`);
  });

  it("reports per-file rejections without failing the whole job", async () => {
    const response = await createJob([
      { eventId: EVENT_ID, relativePath: "front.mp4", size: 10, sha256: "a".repeat(64) },
      { eventId: EVENT_ID, relativePath: "../evil.mp4", size: 10, sha256: "a".repeat(64) },
      { eventId: EVENT_ID, relativePath: "back.mp4", size: 10, sha256: "not-a-digest" },
    ]);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      accepted: unknown[];
      rejected: { index: number; code: string }[];
    };
    expect(body.accepted).toHaveLength(1);
    expect(body.rejected).toEqual([
      { index: 1, code: "invalid_path" },
      { index: 2, code: "invalid_sha256" },
    ]);
  });

  it("rejects malformed request bodies", async () => {
    const response = await worker.fetch("/api/dev/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: "nope" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe("invalid_request");
  });

  it.each([
    { label: "empty", files: [] },
    {
      label: "all rejected",
      files: [
        {
          eventId: EVENT_ID,
          relativePath: "../evil.mp4",
          size: 10,
          sha256: "a".repeat(64),
        },
      ],
    },
  ])("rejects a $label job with no accepted files", async ({ files }) => {
    const response = await createJob(files);
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe("contract_violation");
  });
});

describe("upload and verify round-trip", () => {
  it("uploads a real MP4 and verifies it server-side", async () => {
    const created = (await (
      await createJob([
        {
          eventId: EVENT_ID,
          relativePath: "front.mp4",
          size: fixtureBytes.byteLength,
          sha256: fixtureSha256,
        },
      ])
    ).json()) as { jobId: string; jobToken: string; accepted: { fileId: string }[] };
    const fileId = created.accepted[0]?.fileId;
    expect(fileId).toBeTruthy();

    const granted = (await (
      await grant(created.jobId, created.jobToken, fileId as string)
    ).json()) as { uploadToken: string };
    expect(granted.uploadToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const uploaded = await upload(granted.uploadToken, fixtureBytes);
    expect(uploaded.status).toBe(200);
    const uploadedBody = (await uploaded.json()) as { ok: boolean; key: string; size: number };
    expect(uploadedBody.ok).toBe(true);
    expect(uploadedBody.size).toBe(fixtureBytes.byteLength);

    const verified = await verify(created.jobId, created.jobToken, fileId as string);
    expect(verified.status).toBe(200);
    const verifiedBody = (await verified.json()) as {
      status: string;
      preflight: { code: string };
    };
    expect(verifiedBody.status).toBe("verified");
    expect(verifiedBody.preflight.code).toBe("ready");

    const listed = (await (await status(created.jobId, created.jobToken)).json()) as {
      files: { fileId: string; uploaded: boolean; verified: boolean }[];
    };
    expect(listed.files).toHaveLength(1);
    expect(listed.files[0]?.uploaded).toBe(true);
    expect(listed.files[0]?.verified).toBe(true);
  });

  it("keeps a verified object intact when a replayed upload body is too short", async () => {
    const created = (await (
      await createJob([
        {
          eventId: EVENT_ID,
          relativePath: "front.mp4",
          size: fixtureBytes.byteLength,
          sha256: fixtureSha256,
        },
      ])
    ).json()) as { jobId: string; jobToken: string; accepted: { fileId: string }[] };
    const fileId = created.accepted[0]?.fileId as string;
    const granted = (await (await grant(created.jobId, created.jobToken, fileId)).json()) as {
      uploadToken: string;
    };
    expect((await upload(granted.uploadToken, fixtureBytes)).status).toBe(200);
    expect((await verify(created.jobId, created.jobToken, fileId)).status).toBe(200);

    const shortStream = new ReadableStream({
      start(controller) {
        controller.enqueue(fixtureBytes.subarray(0, fixtureBytes.byteLength - 1));
        controller.close();
      },
    });
    const replayed = await upload(granted.uploadToken, shortStream);
    expect(replayed.status).toBe(400);
    expect(((await replayed.json()) as ApiError).error.code).toBe("content_length_mismatch");

    const listed = (await (await status(created.jobId, created.jobToken)).json()) as {
      files: { preflightCode: string | null; uploaded: boolean; verified: boolean }[];
    };
    expect(listed.files[0]).toMatchObject({
      preflightCode: "ready",
      uploaded: true,
      verified: true,
    });
  });

  it("fails verification on sha256 mismatch and deletes the object", async () => {
    const created = (await (
      await createJob([
        {
          eventId: EVENT_ID,
          relativePath: "front.mp4",
          size: fixtureBytes.byteLength,
          sha256: "0".repeat(64),
        },
      ])
    ).json()) as { jobId: string; jobToken: string; accepted: { fileId: string }[] };
    const fileId = created.accepted[0]?.fileId as string;
    const granted = (await (await grant(created.jobId, created.jobToken, fileId)).json()) as {
      uploadToken: string;
    };
    expect((await upload(granted.uploadToken, fixtureBytes)).status).toBe(200);

    const verified = await verify(created.jobId, created.jobToken, fileId);
    expect(verified.status).toBe(200);
    const body = (await verified.json()) as { status: string; reason: string };
    expect(body).toEqual({ status: "failed", reason: "hash_mismatch" });

    const listed = (await (await status(created.jobId, created.jobToken)).json()) as {
      files: { uploaded: boolean }[];
    };
    expect(listed.files[0]?.uploaded).toBe(false);
  });

  it("rejects chunked uploads whose actual size differs from the declared size", async () => {
    const created = (await (
      await createJob([
        {
          eventId: EVENT_ID,
          relativePath: "front.mp4",
          size: fixtureBytes.byteLength + 100,
          sha256: fixtureSha256,
        },
      ])
    ).json()) as { jobId: string; jobToken: string; accepted: { fileId: string }[] };
    const fileId = created.accepted[0]?.fileId as string;
    const granted = (await (await grant(created.jobId, created.jobToken, fileId)).json()) as {
      uploadToken: string;
    };

    // Chunked body (no Content-Length header) still goes through the
    // FixedLengthStream declared-size gate inside the worker, so the mismatch
    // is rejected at upload time and nothing is stored.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(fixtureBytes);
        controller.close();
      },
    });
    const uploaded = await upload(granted.uploadToken, stream);
    expect(uploaded.status).toBe(400);
    const uploadedBody = (await uploaded.json()) as ApiError;
    expect(uploadedBody.error.code).toBe("content_length_mismatch");

    const listed = (await (await status(created.jobId, created.jobToken)).json()) as {
      files: { uploaded: boolean }[];
    };
    expect(listed.files[0]?.uploaded).toBe(false);
  });

  it("fails verification when the container is not a ready MP4", async () => {
    const garbage = new Uint8Array(fixtureBytes.byteLength).fill(0x42);
    const created = (await (
      await createJob([
        {
          eventId: EVENT_ID,
          relativePath: "front.mp4",
          size: garbage.byteLength,
          sha256: sha256Hex(garbage),
        },
      ])
    ).json()) as { jobId: string; jobToken: string; accepted: { fileId: string }[] };
    const fileId = created.accepted[0]?.fileId as string;
    const granted = (await (await grant(created.jobId, created.jobToken, fileId)).json()) as {
      uploadToken: string;
    };
    expect((await upload(granted.uploadToken, garbage)).status).toBe(200);

    const verified = await verify(created.jobId, created.jobToken, fileId);
    const body = (await verified.json()) as { status: string; reason: string };
    expect(body.status).toBe("failed");
    expect(body.reason).toBe("container_not_ready");
  });

  it("fails verification when the object is missing", async () => {
    const created = (await (
      await createJob([
        { eventId: EVENT_ID, relativePath: "front.mp4", size: 10, sha256: "a".repeat(64) },
      ])
    ).json()) as { jobId: string; jobToken: string; accepted: { fileId: string }[] };
    const fileId = created.accepted[0]?.fileId as string;
    const verified = await verify(created.jobId, created.jobToken, fileId);
    const body = (await verified.json()) as { status: string; reason: string };
    expect(body).toEqual({ status: "failed", reason: "object_missing" });
  });
});

describe("authorization", () => {
  it("rejects upload without a token", async () => {
    const response = await worker.fetch("/api/dev/upload", {
      method: "PUT",
      body: new Uint8Array(8),
      duplex: "half",
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe("missing_token");
  });

  it("does not accept an upload token in the query string", async () => {
    const created = (await (
      await createJob([
        { eventId: EVENT_ID, relativePath: "front.mp4", size: 10, sha256: "a".repeat(64) },
      ])
    ).json()) as { jobId: string; jobToken: string; accepted: { fileId: string }[] };
    const fileId = created.accepted[0]?.fileId as string;
    const granted = (await (await grant(created.jobId, created.jobToken, fileId)).json()) as {
      uploadToken: string;
    };

    const response = await worker.fetch(
      `/api/dev/upload?token=${encodeURIComponent(granted.uploadToken)}`,
      {
        method: "PUT",
        body: new Uint8Array(10),
        duplex: "half",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe("missing_token");
  });

  it("rejects upload with a tampered token", async () => {
    const created = (await (
      await createJob([
        { eventId: EVENT_ID, relativePath: "front.mp4", size: 10, sha256: "a".repeat(64) },
      ])
    ).json()) as { jobId: string; jobToken: string; accepted: { fileId: string }[] };
    const fileId = created.accepted[0]?.fileId as string;
    const granted = (await (await grant(created.jobId, created.jobToken, fileId)).json()) as {
      uploadToken: string;
    };
    const tampered = `${granted.uploadToken.slice(0, -2)}zz`;
    const response = await upload(tampered, new Uint8Array(10));
    expect(response.status).toBe(401);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe("invalid_token");
  });

  it("rejects grant without a Bearer job token", async () => {
    const response = await worker.fetch(`/api/dev/jobs/${"ab".repeat(32)}/grant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileId: "x" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects operations when the URL job id differs from the token", async () => {
    const created = (await (
      await createJob([
        { eventId: EVENT_ID, relativePath: "front.mp4", size: 10, sha256: "a".repeat(64) },
      ])
    ).json()) as { jobId: string; jobToken: string; accepted: { fileId: string }[] };
    const fileId = created.accepted[0]?.fileId as string;
    const otherJobId = "cd".repeat(32);

    const grantResponse = await grant(otherJobId, created.jobToken, fileId);
    expect(grantResponse.status).toBe(403);
    const grantBody = (await grantResponse.json()) as ApiError;
    expect(grantBody.error.code).toBe("job_mismatch");

    const verifyResponse = await verify(otherJobId, created.jobToken, fileId);
    expect(verifyResponse.status).toBe(403);

    const statusResponse = await status(otherJobId, created.jobToken);
    expect(statusResponse.status).toBe(403);
  });

  it("rejects grant for an unknown fileId", async () => {
    const created = (await (
      await createJob([
        { eventId: EVENT_ID, relativePath: "front.mp4", size: 10, sha256: "a".repeat(64) },
      ])
    ).json()) as { jobId: string; jobToken: string };
    const response = await grant(created.jobId, created.jobToken, "f".repeat(32));
    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe("unknown_file");
  });

  it("rejects expired job tokens", async () => {
    // The test harness knows the dev secret, so it can sign a genuine token
    // whose expiry is already in the past. The worker must reject it on time
    // alone, regardless of signature validity.
    const jobId = "ab".repeat(32);
    const expiredPayload: JobTokenPayload = {
      v: 1,
      t: "job",
      jobId,
      iat: 1,
      exp: 2,
      files: [
        {
          eventId: EVENT_ID,
          fileId: "f".repeat(32),
          key: `dev/jobs/${jobId}/${EVENT_ID}/front.mp4`,
          sha256: "a".repeat(64),
          size: 10,
        },
      ],
    };
    const expired = await encodeSignedPayload(expiredPayload, DEV_SECRET);
    const response = await worker.fetch(`/api/dev/jobs/${jobId}/status`, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe("expired_token");
  });
});

describe("upload-time content length check", () => {
  it("rejects a body whose Content-Length differs from the declared size", async () => {
    const created = (await (
      await createJob([
        { eventId: EVENT_ID, relativePath: "front.mp4", size: 10, sha256: "a".repeat(64) },
      ])
    ).json()) as { jobId: string; jobToken: string; accepted: { fileId: string }[] };
    const fileId = created.accepted[0]?.fileId as string;
    const granted = (await (await grant(created.jobId, created.jobToken, fileId)).json()) as {
      uploadToken: string;
    };
    const response = await upload(granted.uploadToken, new Uint8Array(11));
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe("content_length_mismatch");
  });
});

describe("routing", () => {
  it("returns 404 JSON for unknown routes", async () => {
    const response = await worker.fetch("/api/dev/nope");
    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe("not_found");
  });
});
