import { describe, expect, it } from "vitest";
import {
  encodeSignedPayload,
  issueUploadToken,
  UPLOAD_TOKEN_TTL_MS,
  verifyJobTokenDetailed,
  verifyUploadTokenDetailed,
} from "../src/index";

const SECRET = "dev-only-dummy-secret";
const JOB_ID = "ab".repeat(32);
const NOW = 1_754_200_000_000;

const VALID_JOB = {
  v: 1,
  t: "job",
  jobId: JOB_ID,
  iat: NOW,
  exp: NOW + 3_600_000,
  files: [
    {
      fileId: "f".repeat(32),
      eventId: "evt",
      key: `dev/jobs/${JOB_ID}/evt/a.mp4`,
      size: 10,
      sha256: "a".repeat(64),
    },
  ],
} as const;

describe("verifyJobTokenDetailed", () => {
  it("returns ok with the payload for a valid token", async () => {
    const token = await encodeSignedPayload(VALID_JOB, SECRET);
    const result = await verifyJobTokenDetailed(token, SECRET, NOW + 1000);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.payload.jobId).toBe(JOB_ID);
    }
  });

  it("distinguishes expired tokens from invalid ones", async () => {
    const token = await encodeSignedPayload(VALID_JOB, SECRET);
    expect(await verifyJobTokenDetailed(token, SECRET, NOW + 3_600_001)).toEqual({
      status: "expired",
    });

    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...VALID_JOB, exp: NOW + 9_999_999 }),
    ).toString("base64url");
    const signaturePart = token.split(".")[1];
    expect(
      await verifyJobTokenDetailed(`${tamperedPayload}.${signaturePart}`, SECRET, NOW),
    ).toEqual({ status: "invalid" });

    expect(await verifyJobTokenDetailed(token, "wrong-secret", NOW)).toEqual({
      status: "invalid",
    });
    expect(await verifyJobTokenDetailed("garbage", SECRET, NOW)).toEqual({ status: "invalid" });
  });
});

describe("verifyUploadTokenDetailed", () => {
  it("returns ok for a fresh upload token and expired after the TTL", async () => {
    const jobToken = await encodeSignedPayload(VALID_JOB, SECRET);
    const uploadToken = await issueUploadToken(jobToken, "f".repeat(32), SECRET, NOW);
    if (!uploadToken) throw new Error("expected upload token");

    const ok = await verifyUploadTokenDetailed(uploadToken, SECRET, NOW + 1000);
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") {
      expect(ok.payload.exp).toBe(NOW + UPLOAD_TOKEN_TTL_MS);
    }

    expect(
      await verifyUploadTokenDetailed(uploadToken, SECRET, NOW + UPLOAD_TOKEN_TTL_MS + 1),
    ).toEqual({
      status: "expired",
    });
    expect(await verifyUploadTokenDetailed("garbage", SECRET, NOW)).toEqual({
      status: "invalid",
    });
  });
});
