import { describe, expect, it } from "vitest";
import {
  DEV_MAX_FILE_BYTES,
  DEV_MAX_JOB_BYTES,
  DEV_MAX_JOB_FILES,
  DEV_MAX_JOB_TOKEN_BYTES,
  DEV_MAX_OBJECT_KEY_CHARS,
  DEV_MAX_RELATIVE_PATH_CHARS,
  decodeSignedPayload,
  deriveFileId,
  deriveObjectKey,
  encodeSignedPayload,
  issueUploadToken,
  type JobTokenPayload,
  sanitizePathSegments,
  UPLOAD_TOKEN_TTL_MS,
  validateJobId,
  validateSessionFiles,
  validateSha256,
  verifyJobToken,
  verifyUploadToken,
} from "../src/index";

const SECRET = "dev-only-dummy-secret";
const JOB_ID = "ab".repeat(32);
const NOW = 1_754_200_000_000;

describe("constants", () => {
  it("matches the dev limits in the design doc", () => {
    expect(DEV_MAX_FILE_BYTES).toBe(2_147_483_648);
    expect(DEV_MAX_JOB_BYTES).toBe(21_474_836_480);
    expect(DEV_MAX_JOB_FILES).toBe(12);
    expect(DEV_MAX_JOB_TOKEN_BYTES).toBe(12 * 1024);
    expect(DEV_MAX_OBJECT_KEY_CHARS).toBe(512);
    expect(DEV_MAX_RELATIVE_PATH_CHARS).toBe(256);
    expect(UPLOAD_TOKEN_TTL_MS).toBe(300_000);
  });
});

describe("validateJobId", () => {
  it("accepts 64 lowercase hex chars", () => {
    expect(validateJobId(JOB_ID)).toBe(true);
    expect(validateJobId("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("rejects everything else", () => {
    expect(validateJobId("")).toBe(false);
    expect(validateJobId("ab".repeat(31))).toBe(false);
    expect(validateJobId("ab".repeat(33))).toBe(false);
    expect(validateJobId("AB".repeat(32))).toBe(false);
    expect(validateJobId("xy".repeat(32))).toBe(false);
    expect(validateJobId(`${"ab".repeat(31)}../`)).toBe(false);
  });
});

describe("validateSha256", () => {
  it("accepts lowercase hex digests only", () => {
    expect(validateSha256("0".repeat(64))).toBe(true);
    expect(validateSha256("0".repeat(63))).toBe(false);
    expect(validateSha256("F".repeat(64))).toBe(false);
    expect(validateSha256("")).toBe(false);
  });
});

describe("sanitizePathSegments", () => {
  it("accepts safe relative paths and returns segments", () => {
    expect(sanitizePathSegments("front.mp4")).toEqual(["front.mp4"]);
    expect(sanitizePathSegments("SavedClips/2026-08-03_12-34-56/front.mp4")).toEqual([
      "SavedClips",
      "2026-08-03_12-34-56",
      "front.mp4",
    ]);
  });

  it("rejects traversal, empty segments, and unsafe characters", () => {
    expect(sanitizePathSegments("")).toBeNull();
    expect(sanitizePathSegments("..")).toBeNull();
    expect(sanitizePathSegments(".")).toBeNull();
    expect(sanitizePathSegments("a/../b")).toBeNull();
    expect(sanitizePathSegments("a//b")).toBeNull();
    expect(sanitizePathSegments("/a/b")).toBeNull();
    expect(sanitizePathSegments("a".repeat(257))).toBeNull();
    expect(sanitizePathSegments("a/b/")).toBeNull();
    expect(sanitizePathSegments("a\\b")).toBeNull();
    expect(sanitizePathSegments("動画.mp4")).toBeNull();
    expect(sanitizePathSegments("a b.mp4")).toBeNull();
    expect(sanitizePathSegments("a\u0000b.mp4")).toBeNull();
    expect(sanitizePathSegments("-x.mp4")).toEqual(["-x.mp4"]);
    expect(sanitizePathSegments(".hidden")).toEqual([".hidden"]);
  });
});

describe("deriveObjectKey", () => {
  it("builds the documented key shape", () => {
    expect(deriveObjectKey(JOB_ID, "2026-08-03_12-34-56", "SavedClips/front.mp4")).toBe(
      `dev/jobs/${JOB_ID}/2026-08-03_12-34-56/SavedClips/front.mp4`,
    );
  });

  it("rejects invalid inputs", () => {
    expect(deriveObjectKey("nope", "evt", "a.mp4")).toBeNull();
    expect(deriveObjectKey(JOB_ID, "../evil", "a.mp4")).toBeNull();
    expect(deriveObjectKey(JOB_ID, "e".repeat(129), "a.mp4")).toBeNull();
    expect(deriveObjectKey(JOB_ID, "evt", "../a.mp4")).toBeNull();
    expect(deriveObjectKey(JOB_ID, "evt", "a".repeat(257))).toBeNull();
    expect(deriveObjectKey(JOB_ID, "", "a.mp4")).toBeNull();
  });
});

describe("deriveFileId", () => {
  it("is deterministic and 32 hex chars", async () => {
    const first = await deriveFileId("evt", "SavedClips/front.mp4");
    const second = await deriveFileId("evt", "SavedClips/front.mp4");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it("differs per path", async () => {
    const a = await deriveFileId("evt", "front.mp4");
    const b = await deriveFileId("evt", "back.mp4");
    expect(a).not.toBe(b);
  });
});

describe("validateSessionFiles", () => {
  const input = { eventId: "2026-08-03_12-34-56", relativePath: "front.mp4", size: 1000 };

  it("accepts a valid file and assigns fileId and key", async () => {
    const result = await validateSessionFiles(JOB_ID, [input]);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    const accepted = result.accepted[0];
    if (!accepted) throw new Error("expected accepted file");
    expect(accepted.fileId).toMatch(/^[0-9a-f]{32}$/);
    expect(accepted.key).toBe(`dev/jobs/${JOB_ID}/2026-08-03_12-34-56/front.mp4`);
    expect(accepted.size).toBe(1000);
  });

  it("rejects an invalid job id outright", async () => {
    await expect(validateSessionFiles("bad", [input])).rejects.toThrow();
  });

  it("rejects unsafe paths", async () => {
    const result = await validateSessionFiles(JOB_ID, [{ ...input, relativePath: "../x.mp4" }]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ index: 0, code: "invalid_path" }]);
  });

  it("rejects unsafe event ids", async () => {
    const result = await validateSessionFiles(JOB_ID, [{ ...input, eventId: "../evil" }]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ index: 0, code: "invalid_path" }]);
  });

  it("rejects non-positive or non-integer sizes", async () => {
    for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await validateSessionFiles(JOB_ID, [{ ...input, size }]);
      expect(result.accepted).toEqual([]);
      expect(result.rejected[0]?.code).toBe("invalid_size");
    }
  });

  it("rejects files over the per-file limit", async () => {
    const result = await validateSessionFiles(JOB_ID, [{ ...input, size: DEV_MAX_FILE_BYTES + 1 }]);
    expect(result.rejected[0]?.code).toBe("file_size_exceeded");
    expect(
      (await validateSessionFiles(JOB_ID, [{ ...input, size: DEV_MAX_FILE_BYTES }])).rejected,
    ).toEqual([]);
  });

  it("rejects files beyond the file count limit", async () => {
    const inputs = Array.from({ length: DEV_MAX_JOB_FILES + 1 }, (_, index) => ({
      ...input,
      relativePath: `clip-${index}.mp4`,
      size: 1,
    }));
    const result = await validateSessionFiles(JOB_ID, inputs);
    expect(result.accepted).toHaveLength(DEV_MAX_JOB_FILES);
    expect(result.rejected).toEqual([{ index: DEV_MAX_JOB_FILES, code: "too_many_files" }]);
  });

  it("rejects files that push the job over the total byte limit", async () => {
    const inputs = Array.from({ length: 11 }, (_, index) => ({
      ...input,
      relativePath: `clip-${index}.mp4`,
      size: index < 10 ? DEV_MAX_FILE_BYTES : 1,
    }));
    const result = await validateSessionFiles(JOB_ID, inputs);
    expect(result.accepted).toHaveLength(10);
    expect(result.rejected).toEqual([{ index: 10, code: "job_size_exceeded" }]);
  });

  it("rejects duplicate keys and keeps the first occurrence", async () => {
    const result = await validateSessionFiles(JOB_ID, [
      input,
      { ...input, relativePath: "other.mp4" },
      input,
    ]);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([{ index: 2, code: "duplicate_file" }]);
  });

  it("assigns deterministic file ids", async () => {
    const first = await validateSessionFiles(JOB_ID, [input]);
    const second = await validateSessionFiles(JOB_ID, [input]);
    expect(first.accepted[0]?.fileId).toBe(second.accepted[0]?.fileId);
  });
});

describe("signed tokens", () => {
  it("round-trips an arbitrary payload", async () => {
    const payload = { hello: "世界", nested: { n: 1 } };
    const token = await encodeSignedPayload(payload, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await decodeSignedPayload(token, SECRET)).toEqual(payload);
  });

  it("rejects tampered payloads and wrong secrets", async () => {
    const token = await encodeSignedPayload({ a: 1 }, SECRET);
    const signaturePart = token.split(".")[1];
    const tamperedPayload = Buffer.from(JSON.stringify({ a: 2 })).toString("base64url");
    expect(await decodeSignedPayload(`${tamperedPayload}.${signaturePart}`, SECRET)).toBeNull();
    expect(await decodeSignedPayload(token, "other-secret")).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await decodeSignedPayload("", SECRET)).toBeNull();
    expect(await decodeSignedPayload("abc", SECRET)).toBeNull();
    expect(await decodeSignedPayload("a.b.c", SECRET)).toBeNull();
    expect(await decodeSignedPayload("!!!.***", SECRET)).toBeNull();
  });
});

describe("job and upload tokens", () => {
  const files = [
    {
      eventId: "2026-08-03_12-34-56",
      relativePath: "front.mp4",
      size: 1000,
      sha256: "a".repeat(64),
    },
    {
      eventId: "2026-08-03_12-34-56",
      relativePath: "back.mp4",
      size: 2000,
      sha256: "b".repeat(64),
    },
  ];

  async function buildJobToken(nowMs = NOW): Promise<string> {
    const session = await validateSessionFiles(JOB_ID, files);
    const payload: JobTokenPayload = {
      v: 1,
      t: "job",
      jobId: JOB_ID,
      iat: nowMs,
      exp: nowMs + 3_600_000,
      files: session.accepted.map((file) => {
        const source = files.find((f) => f.relativePath.endsWith(file.key.split("/").pop() ?? ""));
        return {
          fileId: file.fileId,
          eventId: file.eventId,
          key: file.key,
          size: file.size,
          sha256: source?.sha256 ?? "0".repeat(64),
        };
      }),
    };
    return encodeSignedPayload(payload, SECRET);
  }

  it("verifies a valid job token", async () => {
    const token = await buildJobToken();
    const payload = await verifyJobToken(token, SECRET, NOW + 1000);
    expect(payload?.jobId).toBe(JOB_ID);
    expect(payload?.files).toHaveLength(2);
  });

  it("rejects expired job tokens", async () => {
    const token = await buildJobToken();
    expect(await verifyJobToken(token, SECRET, NOW + 3_600_001)).toBeNull();
  });

  it("rejects non-job tokens", async () => {
    const token = await encodeSignedPayload(
      { v: 1, t: "upload", jobId: JOB_ID, iat: NOW, exp: NOW + 1000 },
      SECRET,
    );
    expect(await verifyJobToken(token, SECRET, NOW)).toBeNull();
  });

  it("rejects job tokens with invalid files", async () => {
    const token = await encodeSignedPayload(
      {
        v: 1,
        t: "job",
        jobId: JOB_ID,
        iat: NOW,
        exp: NOW + 1000,
        files: [{ fileId: "x", eventId: "e", key: "../bad", size: 1, sha256: "0".repeat(64) }],
      },
      SECRET,
    );
    expect(await verifyJobToken(token, SECRET, NOW)).toBeNull();
  });

  it("issues an upload token for a known file and rejects unknown files", async () => {
    const jobToken = await buildJobToken();
    const jobPayload = await verifyJobToken(jobToken, SECRET, NOW);
    const file = jobPayload?.files[0];
    if (!file) throw new Error("expected job payload");

    const uploadToken = await issueUploadToken(jobToken, file.fileId, SECRET, NOW);
    expect(uploadToken).not.toBeNull();

    const verified = await verifyUploadToken(uploadToken as string, SECRET, NOW + 1000);
    expect(verified).toEqual({
      v: 1,
      t: "upload",
      jobId: JOB_ID,
      fileId: file.fileId,
      key: file.key,
      size: file.size,
      sha256: file.sha256,
      iat: NOW,
      exp: NOW + UPLOAD_TOKEN_TTL_MS,
    });

    expect(await issueUploadToken(jobToken, "unknown-file-id", SECRET, NOW)).toBeNull();
    expect(await issueUploadToken("garbage", file.fileId, SECRET, NOW)).toBeNull();
  });

  it("rejects expired upload tokens", async () => {
    const jobToken = await buildJobToken();
    const jobPayload = await verifyJobToken(jobToken, SECRET, NOW);
    const file = jobPayload?.files[0];
    if (!file) throw new Error("expected job payload");
    const uploadToken = await issueUploadToken(jobToken, file.fileId, SECRET, NOW);
    expect(
      await verifyUploadToken(uploadToken as string, SECRET, NOW + UPLOAD_TOKEN_TTL_MS + 1),
    ).toBeNull();
  });

  it("rejects upload tokens whose key belongs to another job", async () => {
    const forgedPayload = {
      exp: NOW + 60_000,
      fileId: "f".repeat(32),
      iat: NOW,
      jobId: "cd".repeat(32),
      key: `dev/jobs/${JOB_ID}/evt/front.mp4`,
      sha256: "a".repeat(64),
      size: 1,
      t: "upload",
      v: 1,
    };
    const forged = await encodeSignedPayload(forgedPayload, SECRET);
    expect(await verifyUploadToken(forged, SECRET, NOW)).toBeNull();
  });

  it("rejects upload tokens with a bad sha256 in the job source", async () => {
    const bad = await encodeSignedPayload(
      {
        v: 1,
        t: "job",
        jobId: JOB_ID,
        iat: NOW,
        exp: NOW + 60_000,
        files: [
          {
            fileId: "f".repeat(32),
            eventId: "evt",
            key: `dev/jobs/${JOB_ID}/evt/a.mp4`,
            size: 1,
            sha256: "not-a-digest",
          },
        ],
      },
      SECRET,
    );
    expect(await issueUploadToken(bad, "f".repeat(32), SECRET, NOW)).toBeNull();
  });
});
