import { describe, expect, it, vi } from "vitest";
import { ApiError, createDevApiClient } from "./dev-upload-client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("createDevApiClient", () => {
  it("creates a job with the eligible file list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        accepted: [
          { eventId: "e", fileId: "f1", key: "k", relativePath: "p", sha256: "s", size: 1 },
        ],
        expiresAtMs: 123,
        jobId: "job1",
        jobToken: "token1",
        rejected: [],
      }),
    );
    const client = createDevApiClient({ fetchImpl });

    const response = await client.createJob({
      files: [{ eventId: "e", relativePath: "p", sha256: "s", size: 1 }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/dev/jobs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      files: [{ eventId: "e", relativePath: "p", sha256: "s", size: 1 }],
    });
    expect(response.jobId).toBe("job1");
  });

  it("grants an upload token with the job bearer token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { expiresAtMs: 999, uploadToken: "ut" }));
    const client = createDevApiClient({ fetchImpl });

    const response = await client.grant("job1", "token1", "f1");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/dev/jobs/job1/grant");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token1");
    expect(JSON.parse(String(init.body))).toEqual({ fileId: "f1" });
    expect(response.uploadToken).toBe("ut");
  });

  it("uploads the body with a bearer token and keeps it out of the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { key: "k", ok: true, size: 4 }));
    const client = createDevApiClient({ fetchImpl });

    await client.upload("ut", new Blob([new Uint8Array([1, 2, 3, 4])]), () => undefined);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/dev/upload");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ut");
  });

  it("verifies a stored file", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        fileId: "f1",
        key: "k",
        preflight: { code: "ready" },
        sha256: "s",
        size: 1,
        status: "verified",
      }),
    );
    const client = createDevApiClient({ fetchImpl });

    const result = await client.verify("job1", "token1", "f1");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/dev/jobs/job1/verify/f1");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token1");
    expect(result.status).toBe("verified");
  });

  it("reads job status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { files: [], jobId: "job1" }));
    const client = createDevApiClient({ fetchImpl });

    await client.status("job1", "token1");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/dev/jobs/job1/status");
    expect(init.method).toBe("GET");
  });

  it("raises ApiError with the server error code", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: { code: "expired_token" } }));
    const client = createDevApiClient({ fetchImpl });

    await expect(client.grant("job1", "token1", "f1")).rejects.toMatchObject({
      code: "expired_token",
      status: 401,
    });
    expect(ApiError).toBeDefined();
  });

  it("supports a custom base url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { files: [], jobId: "j" }));
    const client = createDevApiClient({ baseUrl: "http://127.0.0.1:8787", fetchImpl });

    await client.status("job1", "t");

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8787/api/dev/jobs/job1/status");
  });
});
