import { describe, it, expect, vi, beforeEach } from "vitest";

type R2Mock = {
  get: ReturnType<typeof vi.fn>;
  head: ReturnType<typeof vi.fn>;
};

const { mockEnv, mockR2 } = vi.hoisted(() => {
  const r2: R2Mock = { get: vi.fn(), head: vi.fn() };
  return {
    mockR2: r2,
    mockEnv: { R2: r2 } as { R2: R2Mock },
  };
});

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock("@/db", () => ({ getDb: vi.fn() }));

import { artifactDownloadHandler } from "../routes/api/artifact-download";
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

function makeRequest(method = "GET", headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/artifacts/a-1/download", {
    method,
    headers,
  });
}

describe("artifactDownloadHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("404s when the artifact row does not exist", async () => {
    mockDb(null);
    const res = await artifactDownloadHandler({
      request: makeRequest(),
      params: { id: "missing" },
    });
    expect(res.status).toBe(404);
  });

  it("404s when R2 has no object for the stored key", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    mockR2.get.mockResolvedValue(null);
    const res = await artifactDownloadHandler({
      request: makeRequest(),
      params: { id: "a-1" },
    });
    expect(res.status).toBe(404);
  });

  it("200s with body, Content-Type, and CORS headers", async () => {
    mockDb({ r2Key: "runs/r1/tr-1/a-1/trace.zip" });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockR2.get.mockResolvedValue(makeR2Body(bytes));

    const res = await artifactDownloadHandler({
      request: makeRequest(),
      params: { id: "a-1" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
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
      request: makeRequest("GET", { Range: "bytes=0-3" }),
      params: { id: "a-1" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-3/100");
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
      request: makeRequest("HEAD"),
      params: { id: "a-1" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("content-length")).toBe("1234");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(mockR2.head).toHaveBeenCalledWith("runs/r1/tr-1/a-1/trace.zip");
  });
});
