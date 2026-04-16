import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, runWithLimit } from "../lib/api-client.js";

describe("ApiClient", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const client = new ApiClient("https://dashboard.example.com", "grn_test123");

  const validPayload = {
    idempotencyKey: "test-key",
    run: {
      ciProvider: null,
      ciBuildId: null,
      branch: "main",
      commitSha: "abc123",
      commitMessage: null,
      prNumber: null,
      repo: null,
      shardIndex: null,
      shardTotal: null,
      status: "passed" as const,
      durationMs: 1000,
      reporterVersion: "0.1.0",
      playwrightVersion: "1.50.0",
    },
    results: [] as never[],
  };

  it("sends POST to /api/ingest with correct headers", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ runId: "abc", runUrl: "/runs/abc" }), {
        status: 201,
      }),
    );

    await client.ingest(validPayload);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://dashboard.example.com/api/ingest",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer grn_test123",
          "Content-Type": "application/json",
          "X-Greenroom-Version": "2",
        }),
      }),
    );
  });

  it("returns IngestResponse on 201", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ runId: "run1", runUrl: "/runs/run1" }), {
        status: 201,
      }),
    );

    const result = await client.ingest(validPayload);
    expect(result.runId).toBe("run1");
    expect(result.runUrl).toBe("/runs/run1");
  });

  it("returns duplicate response on 200", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          runId: "run1",
          runUrl: "/runs/run1",
          duplicate: true,
        }),
        { status: 200 },
      ),
    );

    const result = await client.ingest(validPayload);
    expect(result.duplicate).toBe(true);
  });

  it("throws on 401", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    await expect(client.ingest(validPayload)).rejects.toThrow(
      "Authentication failed",
    );
  });

  it("throws on 409 version mismatch", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "CLI too old" }), { status: 409 }),
    );

    await expect(client.ingest(validPayload)).rejects.toThrow(
      "CLI version incompatible",
    );
  });

  it("retries on 500 errors", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("Server error", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runId: "run1", runUrl: "/runs/run1" }), {
          status: 201,
        }),
      );

    const result = await client.ingest(validPayload);
    expect(result.runId).toBe("run1");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 rate limit", async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response("Rate limited", {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ runId: "run1", runUrl: "/runs/run1" }), {
          status: 201,
        }),
      );

    const result = await client.ingest(validPayload);
    expect(result.runId).toBe("run1");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 400", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Bad request" }), { status: 400 }),
    );

    await expect(client.ingest(validPayload)).rejects.toThrow("Upload failed");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("parses v2 results[] mapping from ingest response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          runId: "run1",
          runUrl: "/runs/run1",
          results: [{ clientKey: "ck-1", testResultId: "tr-1" }],
        }),
        { status: 201 },
      ),
    );
    const result = await client.ingest(validPayload);
    expect(result.results).toEqual([
      { clientKey: "ck-1", testResultId: "tr-1" },
    ]);
  });

  describe("presign", () => {
    it("POSTs to /api/artifacts/presign and returns uploads", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            uploads: [
              {
                artifactId: "a-1",
                url: "https://r2.example/put?sig=abc",
                r2Key: "runs/r1/tr-1/a-1/trace.zip",
                expiresAt: "2026-04-16T00:15:00.000Z",
              },
            ],
          }),
          { status: 201 },
        ),
      );
      const uploads = await client.presign("r1", [
        {
          testResultId: "tr-1",
          type: "trace",
          name: "trace.zip",
          contentType: "application/zip",
          sizeBytes: 128,
        },
      ]);
      expect(uploads).toHaveLength(1);
      expect(uploads[0].artifactId).toBe("a-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://dashboard.example.com/api/artifacts/presign",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws on non-2xx", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Oversized" }), { status: 413 }),
      );
      await expect(
        client.presign("r1", [
          {
            testResultId: "tr-1",
            type: "trace",
            name: "t.zip",
            contentType: "application/zip",
            sizeBytes: 999999999,
          },
        ]),
      ).rejects.toThrow("Oversized");
    });
  });
});

describe("runWithLimit", () => {
  it("runs tasks with bounded concurrency and returns per-task results", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 8 }, (_, i) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    const results = await runWithLimit(3, tasks);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("captures errors without throwing", async () => {
    const results = await runWithLimit(2, [
      async () => {
        throw new Error("boom");
      },
      async () => "ok" as const,
    ]);
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });
});
