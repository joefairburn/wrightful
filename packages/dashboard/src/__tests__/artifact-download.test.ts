import { describe, it, expect, vi, beforeEach } from "vitest";

type R2Mock = {
  get: ReturnType<typeof vi.fn>;
  head: ReturnType<typeof vi.fn>;
};

const { mockEnv, mockR2 } = vi.hoisted(() => {
  const r2: R2Mock = { get: vi.fn(), head: vi.fn() };
  return {
    mockR2: r2,
    mockEnv: {
      R2: r2,
      BETTER_AUTH_SECRET: "test-secret-for-artifact-tokens",
    } as {
      R2: R2Mock;
      BETTER_AUTH_SECRET: string;
    },
  };
});

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock("@/db", () => ({ getDb: vi.fn() }));

import { artifactDownloadHandler } from "../routes/api/artifact-download";
import { signArtifactToken } from "../lib/artifact-tokens";
import { getDb } from "@/db";

const mockedGetDb = vi.mocked(getDb);

function mockDb(row: { r2Key: string } | null) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(row ? [row] : []),
  };
  const db = { select: vi.fn().mockReturnValue(chain) };
  mockedGetDb.mockReturnValue(db as never);
}

function makeR2Body(
  bytes: Uint8Array,
  overrides: Partial<{ size: number; range: unknown }> = {},
) {
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    size: overrides.size ?? bytes.length,
    httpEtag: '"abc123"',
    range: overrides.range,
    writeHttpMetadata: (h: Headers) => {
      h.set("content-type", "application/zip");
    },
  };
}

async function makeRequest(
  method = "GET",
  headers: Record<string, string> = {},
  id = "a-1",
) {
  const token = await signArtifactToken(id);
  return new Request(
    `https://example.com/api/artifacts/${id}/download?t=${encodeURIComponent(token)}`,
    { method, headers },
  );
}

function makeRequestWithoutToken(method = "GET", id = "a-1") {
  return new Request(`https://example.com/api/artifacts/${id}/download`, {
    method,
  });
}

describe("artifactDownloadHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when the signed token is missing", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    const res = await artifactDownloadHandler({
      request: makeRequestWithoutToken(),
      params: { id: "a-1" },
    });
    expect(res.status).toBe(401);
  });

  it("401s when the token is valid for a different artifact", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    const token = await signArtifactToken("other-artifact");
    const req = new Request(
      `https://example.com/api/artifacts/a-1/download?t=${encodeURIComponent(token)}`,
    );
    const res = await artifactDownloadHandler({
      request: req,
      params: { id: "a-1" },
    });
    expect(res.status).toBe(401);
  });

  it("404s when the artifact row does not exist", async () => {
    mockDb(null);
    const res = await artifactDownloadHandler({
      request: await makeRequest("GET", {}, "missing"),
      params: { id: "missing" },
    });
    expect(res.status).toBe(404);
  });

  it("404s when R2 has no object for the stored key", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    mockR2.get.mockResolvedValue(null);
    const res = await artifactDownloadHandler({
      request: await makeRequest(),
      params: { id: "a-1" },
    });
    expect(res.status).toBe(404);
  });

  it("200s with body, Content-Type, and dashboard-origin CORS headers", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockR2.get.mockResolvedValue(makeR2Body(bytes));

    const res = await artifactDownloadHandler({
      request: await makeRequest(),
      params: { id: "a-1" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://example.com",
    );
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("etag")).toBe('"abc123"');

    const received = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(bytes));

    expect(mockR2.get).toHaveBeenCalledWith(
      "runs/r1/tr-1/a-1/trace.zip",
      expect.objectContaining({ range: expect.any(Headers) }),
    );
  });

  it("returns 206 with Content-Range for a Range request", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockR2.get.mockResolvedValue(
      makeR2Body(bytes, {
        size: 100,
        range: { offset: 0, length: bytes.length },
      }),
    );

    const res = await artifactDownloadHandler({
      request: await makeRequest("GET", { Range: "bytes=0-3" }),
      params: { id: "a-1" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-3/100");
  });

  it("returns 200 (not 206) when R2 ignores an unsatisfiable Range", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockR2.get.mockResolvedValue(makeR2Body(bytes, { range: undefined }));

    const res = await artifactDownloadHandler({
      request: await makeRequest("GET", { Range: "bytes=abc-def" }),
      params: { id: "a-1" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
  });

  it("HEAD returns headers without body via env.R2.head", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    mockR2.head.mockResolvedValue({
      size: 1234,
      httpEtag: '"abc123"',
      writeHttpMetadata: (h: Headers) => {
        h.set("content-type", "application/zip");
      },
    });

    const res = await artifactDownloadHandler({
      request: await makeRequest("HEAD"),
      params: { id: "a-1" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("content-length")).toBe("1234");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://example.com",
    );
    expect(mockR2.head).toHaveBeenCalledWith("runs/r1/tr-1/a-1/trace.zip");
  });

  it("echoes the Playwright trace viewer origin when set", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockR2.get.mockResolvedValue(makeR2Body(bytes));

    const res = await artifactDownloadHandler({
      request: await makeRequest("GET", {
        Origin: "https://trace.playwright.dev",
      }),
      params: { id: "a-1" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://trace.playwright.dev",
    );
  });

  it("falls back to dashboard origin for unknown cross-origin callers", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockR2.get.mockResolvedValue(makeR2Body(bytes));

    const res = await artifactDownloadHandler({
      request: await makeRequest("GET", { Origin: "https://evil.example.com" }),
      params: { id: "a-1" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://example.com",
    );
  });
});
