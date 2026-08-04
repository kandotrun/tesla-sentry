import {
  DEV_MAX_FILE_BYTES,
  DEV_MAX_JOB_BYTES,
  DEV_MAX_JOB_FILES,
} from "@sentry-check/upload-session";
import { describe, expect, it, vi } from "vitest";
import {
  type ApiTransport,
  batchDevUploadFiles,
  type DevUploadJobPlan,
  type PlanInputFile,
  planDevUploadJob,
} from "./dev-upload-pipeline";

describe("batchDevUploadFiles", () => {
  it("starts a new job before the file-count limit is exceeded", () => {
    const files = Array.from({ length: DEV_MAX_JOB_FILES + 1 }, () => ({ size: 1 }));
    expect(batchDevUploadFiles(files).map((batch) => batch.length)).toEqual([DEV_MAX_JOB_FILES, 1]);
  });

  it("starts a new job before the byte limit is exceeded", () => {
    const files = Array.from({ length: DEV_MAX_JOB_BYTES / DEV_MAX_FILE_BYTES + 1 }, () => ({
      size: DEV_MAX_FILE_BYTES,
    }));
    expect(batchDevUploadFiles(files).map((batch) => batch.length)).toEqual([10, 1]);
  });
});

function file(input: Partial<PlanInputFile> = {}): PlanInputFile {
  return {
    eventId: "2026-08-01_12-00-00",
    fingerprint: "fp-1",
    name: "front.mp4",
    relativePath: "TeslaCam/SentryClips/2026-08-01_12-00-00/front.mp4",
    sha256: "a".repeat(64),
    size: 1024,
    status: "eligible",
    ...input,
  };
}

function jobResponse(fileIds: readonly string[]) {
  return {
    accepted: fileIds.map((fileId, index) => ({
      eventId: "2026-08-01_12-00-00",
      fileId,
      key: `dev/jobs/job1/2026-08-01_12-00-00/front${index}.mp4`,
      relativePath: `front${index}.mp4`,
      sha256: "a".repeat(64),
      size: 1024,
    })),
    expiresAtMs: Date.now() + 3_600_000,
    jobId: "job1",
    jobToken: "jobtoken",
    rejected: [],
  };
}

describe("planDevUploadJob", () => {
  it("selects only eligible clips for the job", () => {
    const transport: ApiTransport = {
      createJob: vi.fn().mockResolvedValue(jobResponse(["f1"])),
    };
    const input: DevUploadJobPlan = {
      files: [
        file(),
        file({ fingerprint: "fp-2", name: "blocked.mp4", status: "blocked" }),
        file({ fingerprint: "fp-3", name: "pending.mp4", status: "pending" }),
      ],
    };
    return planDevUploadJob(input, transport).then((result) => {
      const createJob = vi.mocked(transport.createJob);
      expect(createJob).toHaveBeenCalledTimes(1);
      const request = createJob.mock.calls[0]?.[0];
      expect(request).toBeDefined();
      if (!request) {
        throw new Error("createJob request missing");
      }
      expect(request.files).toHaveLength(1);
      expect(request.files[0]?.relativePath).toBe(
        "TeslaCam/SentryClips/2026-08-01_12-00-00/front.mp4",
      );
      expect(result.acceptedFileIds).toEqual(["f1"]);
    });
  });

  it("rejects when the server rejects some files", async () => {
    const transport: ApiTransport = {
      createJob: vi.fn().mockResolvedValue({
        accepted: [],
        expiresAtMs: Date.now() + 1000,
        jobId: "job1",
        jobToken: "jobtoken",
        rejected: [{ code: "invalid_path", index: 0 }],
      }),
    };
    const input: DevUploadJobPlan = { files: [file()] };
    await expect(planDevUploadJob(input, transport)).rejects.toThrow(
      "server rejected file index 0: invalid_path",
    );
  });

  it("throws when no files are eligible", async () => {
    const transport: ApiTransport = { createJob: vi.fn() };
    const input: DevUploadJobPlan = { files: [file({ status: "blocked" })] };
    await expect(planDevUploadJob(input, transport)).rejects.toThrow("no eligible");
    expect(vi.mocked(transport.createJob)).not.toHaveBeenCalled();
  });
});
