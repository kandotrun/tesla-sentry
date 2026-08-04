import type { UploadPlanV1 } from "@sentry-check/upload-contract";
import { DEV_MAX_JOB_FILES } from "@sentry-check/upload-session";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DevUploadPanel } from "./DevUploadPanel";
import type { DevApiClient } from "./dev-upload-client";

function eligiblePlan(clipCount = 1): UploadPlanV1 {
  return {
    items: Array.from({ length: clipCount }, (_, index) => ({
      camera: "front",
      capturedAt: null,
      eventId: "2026-08-01_12-00-00",
      fingerprint: `fp-${index}`,
      ineligibilityReason: null,
      name: `front-${index}.mp4`,
      preflight: {
        code: "ready",
        codec: "avc1.42c00a",
        durationSeconds: 60,
        encrypted: false,
        height: 90,
        scannedBytes: 1024,
        width: 160,
      },
      relativePath: `TeslaCam/SentryClips/2026-08-01_12-00-00/front-${index}.mp4`,
      size: 1024,
      status: "eligible" as const,
      warningCodes: [],
    })),
    schemaVersion: 1,
    totals: {
      blockedClips: 0,
      eligibleBytes: 1024 * clipCount,
      eligibleClips: clipCount,
      eligibleDurationSeconds: 60 * clipCount,
      pendingClips: 0,
      sourceClips: clipCount,
    },
  };
}

function localFile(name: string): File {
  return new File(["dev-upload-test-body"], name, { type: "video/mp4" });
}

interface FakeClientOptions {
  readonly createJob?: DevApiClient["createJob"];
  readonly verify?: DevApiClient["verify"];
}

function fakeClient(options: FakeClientOptions = {}): DevApiClient {
  return {
    createJob:
      options.createJob ??
      vi.fn(
        async ({
          files,
        }: {
          readonly files: readonly {
            readonly eventId: string;
            readonly relativePath: string;
            readonly sha256: string;
            readonly size: number;
          }[];
        }) => ({
          accepted: files.map((file, index) => ({
            eventId: file.eventId,
            fileId: `file-${index}`,
            key: `dev/jobs/job-1/${file.eventId}/front-${index}.mp4`,
            relativePath: file.relativePath,
            sha256: file.sha256,
            size: file.size,
          })),
          expiresAtMs: Date.now() + 60_000,
          jobId: "job-1",
          jobToken: "job-token-1",
          rejected: [],
        }),
      ),
    grant: vi.fn(async () => ({ expiresAtMs: Date.now() + 60_000, uploadToken: "upload-token-1" })),
    status: vi.fn(async () => ({ files: [], jobId: "job-1" })),
    upload: vi.fn(async (_token, body, onProgress) => {
      onProgress(body.size);
    }),
    verify:
      options.verify ??
      vi.fn(async () => ({
        fileId: "file-0",
        key: "k",
        preflight: {
          code: "ready" as const,
          codec: "avc1.42c00a",
          durationSeconds: 60,
          encrypted: false,
          height: 90,
          scannedBytes: 1024,
          width: 160,
        },
        sha256: "s",
        size: 1024,
        status: "verified" as const,
      })),
  };
}

describe("DevUploadPanel", () => {
  it("states this is a dev-only feature and does not start uploading automatically", () => {
    render(
      <DevUploadPanel
        apiClient={fakeClient()}
        filesByFingerprint={new Map([["fp-0", localFile("front-0.mp4")]])}
        hashFile={async () => "a".repeat(64)}
        plan={eligiblePlan()}
      />,
    );
    expect(screen.getByText(/開発環境専用/)).toBeInTheDocument();
    expect(screen.getByText(/ローカル開発環境にだけ保存/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /アップロード/ })).toBeInTheDocument();
  });

  it("does not offer an upload action when there are no eligible clips", () => {
    const plan = eligiblePlan();
    render(
      <DevUploadPanel
        apiClient={fakeClient()}
        filesByFingerprint={new Map()}
        hashFile={async () => "a".repeat(64)}
        plan={{ ...plan, items: [], totals: { ...plan.totals, eligibleClips: 0, sourceClips: 0 } }}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/候補がありません/)).toBeInTheDocument();
  });

  it("hashes, uploads, and verifies eligible clips in order", async () => {
    const client = fakeClient();
    const hashFile = vi.fn(async () => "b".repeat(64));
    render(
      <DevUploadPanel
        apiClient={client}
        filesByFingerprint={
          new Map([
            ["fp-0", localFile("front-0.mp4")],
            ["fp-1", localFile("front-1.mp4")],
          ])
        }
        hashFile={hashFile}
        plan={eligiblePlan(2)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /アップロード/ }));

    await waitFor(() => {
      expect(screen.getAllByText("検証済み")).toHaveLength(2);
    });
    expect(hashFile).toHaveBeenCalledTimes(2);
    expect(client.createJob).toHaveBeenCalledTimes(1);
    expect(client.grant).toHaveBeenCalledTimes(2);
    expect(client.upload).toHaveBeenCalledTimes(2);
    expect(client.verify).toHaveBeenCalledTimes(2);
  });

  it("creates multiple bounded jobs when eligible clips exceed one token batch", async () => {
    const clipCount = DEV_MAX_JOB_FILES + 1;
    const client = fakeClient();
    const files = new Map(
      Array.from({ length: clipCount }, (_, index) => [
        `fp-${index}`,
        localFile(`front-${index}.mp4`),
      ]),
    );
    render(
      <DevUploadPanel
        apiClient={client}
        filesByFingerprint={files}
        hashFile={async () => "b".repeat(64)}
        plan={eligiblePlan(clipCount)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /アップロード/ }));

    await waitFor(() => {
      expect(screen.getAllByText("検証済み")).toHaveLength(clipCount);
    });
    expect(client.createJob).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.createJob).mock.calls.map((call) => call[0].files.length)).toEqual([
      DEV_MAX_JOB_FILES,
      1,
    ]);
  });

  it("marks a file failed with the server reason and keeps going", async () => {
    const client = fakeClient({
      verify: vi.fn(async (_jobId, _token, fileId) =>
        fileId === "file-0"
          ? { reason: "hash_mismatch", status: "failed" as const }
          : {
              fileId,
              key: "k",
              preflight: {
                code: "ready" as const,
                codec: null,
                durationSeconds: 1,
                encrypted: false,
                height: 1,
                scannedBytes: 1,
                width: 1,
              },
              sha256: "s",
              size: 1,
              status: "verified" as const,
            },
      ),
    });
    render(
      <DevUploadPanel
        apiClient={client}
        filesByFingerprint={
          new Map([
            ["fp-0", localFile("front-0.mp4")],
            ["fp-1", localFile("front-1.mp4")],
          ])
        }
        hashFile={async () => "b".repeat(64)}
        plan={eligiblePlan(2)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /アップロード/ }));

    await waitFor(() => {
      expect(screen.getByText(/ハッシュ不一致/)).toBeInTheDocument();
    });
    expect(screen.getByText("検証済み")).toBeInTheDocument();
    expect(client.upload).toHaveBeenCalledTimes(2);
  });

  it("tracks clips with the same filename independently by fingerprint", async () => {
    const basePlan = eligiblePlan(2);
    const plan: UploadPlanV1 = {
      ...basePlan,
      items: basePlan.items.map((item, index) => ({
        ...item,
        eventId: `event-${index}`,
        name: "shared-front.mp4",
        relativePath: `TeslaCam/SentryClips/event-${index}/shared-front.mp4`,
      })),
    };
    const client = fakeClient({
      verify: vi.fn(async (_jobId, _token, fileId) =>
        fileId === "file-0"
          ? { reason: "hash_mismatch", status: "failed" as const }
          : {
              fileId,
              key: "k",
              preflight: {
                code: "ready" as const,
                codec: "avc1",
                durationSeconds: 60,
                encrypted: false,
                height: 90,
                scannedBytes: 1024,
                width: 160,
              },
              sha256: "s",
              size: 1024,
              status: "verified" as const,
            },
      ),
    });
    render(
      <DevUploadPanel
        apiClient={client}
        filesByFingerprint={
          new Map([
            ["fp-0", localFile("shared-front.mp4")],
            ["fp-1", localFile("shared-front.mp4")],
          ])
        }
        hashFile={async () => "b".repeat(64)}
        plan={plan}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /アップロード/ }));

    await waitFor(() => {
      expect(screen.getByText(/ハッシュ不一致/)).toBeInTheDocument();
      expect(screen.getAllByText("検証済み")).toHaveLength(1);
    });
  });

  it("keeps accepted file ids aligned after an earlier file is rejected", async () => {
    const createJob = vi.fn<DevApiClient["createJob"]>(async ({ files }) => {
      const accepted = files[1];
      if (!accepted) {
        throw new Error("second input missing");
      }
      return {
        accepted: [
          {
            ...accepted,
            fileId: "file-1",
            key: `dev/jobs/job-1/${accepted.eventId}/${accepted.relativePath}`,
          },
        ],
        expiresAtMs: Date.now() + 60_000,
        jobId: "job-1",
        jobToken: "job-token-1",
        rejected: [{ code: "invalid_path", index: 0 }],
      };
    });
    const client = fakeClient({ createJob });
    render(
      <DevUploadPanel
        apiClient={client}
        filesByFingerprint={
          new Map([
            ["fp-0", localFile("front-0.mp4")],
            ["fp-1", localFile("front-1.mp4")],
          ])
        }
        hashFile={async () => "b".repeat(64)}
        plan={eligiblePlan(2)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /アップロード/ }));

    await waitFor(() => {
      expect(screen.getByText("検証済み")).toBeInTheDocument();
      expect(screen.getByText(/サーバーがファイルを拒否しました/)).toBeInTheDocument();
    });
    expect(client.grant).toHaveBeenCalledWith("job-1", "job-token-1", "file-1");
    const uploadedBody = vi.mocked(client.upload).mock.calls[0]?.[1];
    expect(uploadedBody).toBeInstanceOf(File);
    expect((uploadedBody as File).name).toBe("front-1.mp4");
  });

  it("marks a missing selected file as failed instead of leaving it waiting", async () => {
    const client = fakeClient();
    render(
      <DevUploadPanel
        apiClient={client}
        filesByFingerprint={new Map([["fp-1", localFile("front-1.mp4")]])}
        hashFile={async () => "b".repeat(64)}
        plan={eligiblePlan(2)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /アップロード/ }));

    await waitFor(() => {
      expect(screen.getByText(/選択元ファイルが見つかりません/)).toBeInTheDocument();
      expect(screen.getByText("検証済み")).toBeInTheDocument();
    });
    expect(client.upload).toHaveBeenCalledTimes(1);
  });

  it("never shows verified for a file that was not uploaded", async () => {
    const client = fakeClient();
    render(
      <DevUploadPanel
        apiClient={client}
        filesByFingerprint={new Map([["fp-0", localFile("front-0.mp4")]])}
        hashFile={async () => "b".repeat(64)}
        plan={eligiblePlan()}
      />,
    );
    expect(screen.queryByText("検証済み")).toBeNull();
  });
});
