import { describe, it, expect, vi, beforeEach } from "vitest";

type R2Mock = {
  put: ReturnType<typeof vi.fn>;
};

const { mockEnv, mockR2, tenantDbRef } = vi.hoisted(() => {
  const r2: R2Mock = { put: vi.fn() };
  return {
    mockR2: r2,
    mockEnv: { R2: r2 } as { R2: R2Mock },
    tenantDbRef: { current: null as unknown },
  };
});

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock("@/tenant", () => ({
  tenantScopeForApiKey: vi.fn(async (apiKey: { projectId: string } | null) => {
    if (!apiKey || !tenantDbRef.current) return null;
    return {
      teamId: "team-1",
      teamSlug: "t",
      projectId: apiKey.projectId,
      projectSlug: "p",
      db: tenantDbRef.current,
      batch: async () => {},
    };
  }),
}));

import { makeTenantTestDb, selectResult } from "./helpers/test-db";
import { artifactUploadHandler } from "../routes/api/artifact-upload";

const AUTH_CTX = {
  apiKey: { id: "key-1", label: "test", projectId: "proj-1" },
};

function mockDb(
  row: { r2Key: string; contentType: string; sizeBytes: number } | null,
) {
  const tenant = makeTenantTestDb();
  tenant.driver.results.push(
    selectResult(row ? [row as unknown as Record<string, unknown>] : []),
  );
  tenantDbRef.current = tenant.db;
}

function mockDbNoScope() {
  tenantDbRef.current = null;
}

function makeRequest(
  body: BodyInit | null,
  headers: Record<string, string> = {},
) {
  return new Request("https://example.com/api/artifacts/a-1/upload", {
    method: "PUT",
    headers,
    body,
    // @ts-expect-error — duplex not in standard RequestInit
    duplex: "half",
  });
}

describe("artifactUploadHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when no API key on the context", async () => {
    const res = await artifactUploadHandler({
      request: makeRequest("x", { "content-length": "1" }),
      params: { id: "a-1" },
      ctx: {},
    });
    expect(res.status).toBe(401);
  });

  it("404s when the scope lookup fails", async () => {
    mockDbNoScope();
    const res = await artifactUploadHandler({
      request: makeRequest("x", { "content-length": "1" }),
      params: { id: "a-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(404);
  });

  it("404s when the artifact row is missing or cross-tenant", async () => {
    mockDb(null);
    const res = await artifactUploadHandler({
      request: makeRequest("x", { "content-length": "1" }),
      params: { id: "missing" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(404);
  });

  it("400s on missing Content-Length", async () => {
    mockDb({
      r2Key: "runs/r1/tr-1/a-1/trace.zip",
      contentType: "application/zip",
      sizeBytes: 3,
    });
    const res = await artifactUploadHandler({
      request: makeRequest("abc"),
      params: { id: "a-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("400s when Content-Length does not match registered sizeBytes", async () => {
    mockDb({
      r2Key: "runs/r1/tr-1/a-1/trace.zip",
      contentType: "application/zip",
      sizeBytes: 10,
    });
    const res = await artifactUploadHandler({
      request: makeRequest("abc", { "content-length": "3" }),
      params: { id: "a-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("204s on success and streams into env.R2.put with stored contentType", async () => {
    mockDb({
      r2Key: "runs/r1/tr-1/a-1/trace.zip",
      contentType: "application/zip",
      sizeBytes: 3,
    });
    mockR2.put.mockResolvedValue(undefined);

    const res = await artifactUploadHandler({
      request: makeRequest("abc", { "content-length": "3" }),
      params: { id: "a-1" },
      ctx: AUTH_CTX,
    });

    expect(res.status).toBe(204);
    expect(mockR2.put).toHaveBeenCalledTimes(1);
    const [key, body, opts] = mockR2.put.mock.calls[0];
    expect(key).toBe("runs/r1/tr-1/a-1/trace.zip");
    expect(body).toBeInstanceOf(ReadableStream);
    expect(opts).toEqual({ httpMetadata: { contentType: "application/zip" } });
  });

  it("502s if env.R2.put throws", async () => {
    mockDb({
      r2Key: "runs/r1/tr-1/a-1/trace.zip",
      contentType: "application/zip",
      sizeBytes: 3,
    });
    mockR2.put.mockRejectedValue(new Error("R2 is down"));

    const res = await artifactUploadHandler({
      request: makeRequest("abc", { "content-length": "3" }),
      params: { id: "a-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("R2 is down");
  });
});
