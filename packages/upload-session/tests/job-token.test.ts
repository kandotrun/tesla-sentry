import { describe, expect, it } from "vitest";
import {
  createJobToken,
  DEV_MAX_FILE_BYTES,
  DEV_MAX_JOB_FILES,
  DEV_MAX_JOB_TOKEN_BYTES,
  extractBearerToken,
  type JobFileInput,
  verifyJobToken,
} from "../src/index";

const SECRET = "dev-only-dummy-secret";
const JOB_ID = "ab".repeat(32);
const NOW = 1_754_200_000_000;

const FILE: JobFileInput = {
  eventId: "2026-08-03_12-34-56",
  relativePath: "front.mp4",
  size: 1000,
  sha256: "a".repeat(64),
};

describe("extractBearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(extractBearerToken("Bearer abc.def")).toBe("abc.def");
  });

  it("is case-insensitive about the scheme and trims whitespace", () => {
    expect(extractBearerToken("bearer  abc.def ")).toBe("abc.def");
  });

  it("returns null for missing, empty, or non-Bearer headers", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
  });
});

describe("createJobToken", () => {
  it("issues a job token for valid files and reports rejections", async () => {
    const result = await createJobToken(JOB_ID, [FILE], SECRET, {
      nowMs: NOW,
      expiresAtMs: NOW + 3_600_000,
    });
    if (result.code === "contract_violation") throw new Error("expected ok");
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.sha256).toBe(FILE.sha256);
    expect(result.rejected).toEqual([]);
    const payload = await verifyJobToken(result.jobToken, SECRET, NOW + 1000);
    expect(payload?.jobId).toBe(JOB_ID);
    expect(payload?.files).toHaveLength(1);
  });

  it("rejects a job when every sha256 declaration is malformed", async () => {
    const result = await createJobToken(JOB_ID, [{ ...FILE, sha256: "XYZ" }], SECRET, {
      nowMs: NOW,
      expiresAtMs: NOW + 60_000,
    });
    expect(result).toEqual({ code: "contract_violation", reason: "no_accepted_files" });
  });

  it("rejects an empty job", async () => {
    const result = await createJobToken(JOB_ID, [], SECRET, {
      nowMs: NOW,
      expiresAtMs: NOW + 60_000,
    });
    expect(result).toEqual({ code: "contract_violation", reason: "no_accepted_files" });
  });

  it("keeps rejection indices aligned with the input array", async () => {
    const result = await createJobToken(
      JOB_ID,
      [FILE, { ...FILE, sha256: "nope" }, { ...FILE, relativePath: "../x.mp4" }],
      SECRET,
      { nowMs: NOW, expiresAtMs: NOW + 60_000 },
    );
    if (result.code === "contract_violation") throw new Error("expected ok");
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.map((rejection) => rejection.index)).toEqual([1, 2]);
  });

  it("fails closed on an invalid job id", async () => {
    const result = await createJobToken("bad", [FILE], SECRET, {
      nowMs: NOW,
      expiresAtMs: NOW + 60_000,
    });
    expect(result.code).toBe("contract_violation");
  });

  it("fails closed on contract violations", async () => {
    const tooBig: JobFileInput = { ...FILE, size: DEV_MAX_FILE_BYTES + 1 };
    expect(
      (await createJobToken(JOB_ID, [tooBig], SECRET, { nowMs: NOW, expiresAtMs: NOW + 60_000 }))
        .code,
    ).toBe("contract_violation");

    const tooMany = Array.from({ length: DEV_MAX_JOB_FILES + 1 }, (_, index) => ({
      ...FILE,
      relativePath: `clip-${index}.mp4`,
      size: 1,
    }));
    expect(
      (await createJobToken(JOB_ID, tooMany, SECRET, { nowMs: NOW, expiresAtMs: NOW + 60_000 }))
        .code,
    ).toBe("contract_violation");
  });

  it("keeps a maximum-sized valid job token within the header budget", async () => {
    const files = Array.from({ length: DEV_MAX_JOB_FILES }, (_, index) => {
      const id = String(index).padStart(2, "0");
      return {
        ...FILE,
        eventId: `${id}${"e".repeat(126)}`,
        relativePath: `${"p".repeat(128)}/${id}-${"q".repeat(124)}`,
        size: 1,
      };
    });
    const result = await createJobToken(JOB_ID, files, SECRET, {
      nowMs: NOW,
      expiresAtMs: NOW + 60_000,
    });
    if (result.code === "contract_violation") {
      throw new Error(`expected ok, got ${result.reason}`);
    }
    expect(new TextEncoder().encode(result.jobToken).byteLength).toBeLessThanOrEqual(
      DEV_MAX_JOB_TOKEN_BYTES,
    );
  });
});
