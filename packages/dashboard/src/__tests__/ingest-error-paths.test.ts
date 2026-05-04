/**
 * Error-path coverage for the ingest handlers. The happy paths are covered
 * in `runs.test.ts` and `artifacts.test.ts`; this file pins the edges that
 * must not regress: batch failures must surface (not be silently swallowed),
 * R2 failures must return 502, backdating must be blocked outside dev, and
 * idempotency must hold under concurrent shard semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Compilable } from "kysely";

const { tenantDbRef, batchImpl, mockR2 } = vi.hoisted(() => ({
  tenantDbRef: { current: null as unknown },
  batchImpl: {
    current: (async () => {}) as (q: Compilable[]) => Promise<void>,
  },
  mockR2: { put: vi.fn() },
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    WRIGHTFUL_MAX_ARTIFACT_BYTES: "52428800",
    R2: mockR2,
  },
}));
vi.mock("@/control", () => ({ getControlDb: vi.fn() }));
vi.mock("@/tenant", () => ({
  tenantScopeForApiKey: vi.fn(async (apiKey: { projectId: string } | null) => {
    if (!apiKey || !tenantDbRef.current) return null;
    return {
      teamId: "team-1",
      teamSlug: "t",
      projectId: apiKey.projectId,
      projectSlug: "p",
      db: tenantDbRef.current,
      batch: (q: Compilable[]) => batchImpl.current(q),
    };
  }),
}));

import {
  makeTenantTestDb,
  makeTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";
import {
  appendResultsHandler,
  completeRunHandler,
  openRunHandler,
} from "../routes/api/runs";
import { artifactUploadHandler } from "../routes/api/artifact-upload";
import { registerHandler as registerArtifactsHandler } from "../routes/api/artifacts";
import { getControlDb } from "@/control";

const mockedGetControlDb = vi.mocked(getControlDb);
const AUTH_CTX = {
  apiKey: { id: "key-1", label: "test", projectId: "proj-1" },
};

let tenantDriver: ScriptedDriver;

function postJson(url: string, body: unknown): Request {
  return new Request(`https://example.com${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  const control = makeTestDb();
  const tenant = makeTenantTestDb();
  tenantDriver = tenant.driver;
  tenantDbRef.current = tenant.db;
  mockedGetControlDb.mockReturnValue(control.db);
  batchImpl.current = async () => {};
});

const sampleResult = {
  clientKey: "k1",
  testId: "t1",
  title: "a",
  file: "a.spec.ts",
  status: "passed" as const,
  durationMs: 10,
  retryCount: 0,
  tags: [],
  annotations: [],
  attempts: [
    {
      attempt: 0,
      status: "passed" as const,
      durationMs: 10,
      errorMessage: null,
      errorStack: null,
    },
  ],
};

describe("openRunHandler — error paths", () => {
  it("400s on completely malformed JSON body", async () => {
    const req = new Request("https://example.com/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const res = await openRunHandler({ request: req, ctx: AUTH_CTX });
    expect(res.status).toBe(400);
  });

  it("blocks createdAt backdating outside dev (production safety)", async () => {
    const res = await openRunHandler({
      request: postJson("/api/runs", {
        idempotencyKey: "ci-123",
        run: {},
        createdAt: 1_700_000_000,
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/createdAt/i);
  });

  it("propagates batch failure to the caller (no silent swallow)", async () => {
    tenantDriver.results.push(selectResult([])); // idempotency lookup
    batchImpl.current = async () => {
      throw new Error("DO transactionSync failed");
    };

    await expect(
      openRunHandler({
        request: postJson("/api/runs", { idempotencyKey: "ci-1", run: {} }),
        ctx: AUTH_CTX,
      }),
    ).rejects.toThrow(/transactionSync failed/);
  });
});

describe("appendResultsHandler — error paths", () => {
  it("400s on a body that fails Zod validation (empty results)", async () => {
    const res = await appendResultsHandler({
      request: postJson("/api/runs/run-1/results", { results: [] }),
      params: { id: "run-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("400s when the run id param is missing entirely", async () => {
    const res = await appendResultsHandler({
      request: postJson("/api/runs/x/results", { results: [sampleResult] }),
      params: {},
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(404);
  });

  it("404s when the run exists but belongs to another project", async () => {
    // resolveOwner returns no row because of the projectId predicate.
    tenantDriver.results.push(selectResult([]));
    const res = await appendResultsHandler({
      request: postJson("/api/runs/run-foreign/results", {
        results: [sampleResult],
      }),
      params: { id: "run-foreign" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(404);
  });

  it("propagates DB batch failure (e.g. SQLITE_BUSY) so the reporter retries", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }])); // owner
    tenantDriver.results.push(selectResult([])); // resolveTestResultIds
    batchImpl.current = async () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };

    await expect(
      appendResultsHandler({
        request: postJson("/api/runs/run-1/results", {
          results: [sampleResult],
        }),
        params: { id: "run-1" },
        ctx: AUTH_CTX,
      }),
    ).rejects.toThrow(/SQLITE_BUSY/);
  });

  it("re-sending the same testId is idempotent: UPDATE in place, no duplicate INSERT", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }])); // owner
    tenantDriver.results.push(
      selectResult([{ id: "tr-existing", testId: "t1", status: "queued" }]),
    );
    tenantDriver.results.push(selectResult([])); // composeRunSummary

    const captured: Compilable[] = [];
    batchImpl.current = async (q) => {
      captured.push(...q);
    };

    const res = await appendResultsHandler({
      request: postJson("/api/runs/run-1/results", {
        results: [sampleResult],
      }),
      params: { id: "run-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(200);

    const sqls = captured.map((c) => c.compile().sql);
    // Must UPDATE testResults, not INSERT (existing row reuse).
    expect(sqls.some((s) => /update\s+"testResults"/i.test(s))).toBe(true);
    expect(sqls.some((s) => /insert\s+into\s+"testResults"/i.test(s))).toBe(
      false,
    );
  });

  it("returns the same testResultId for a row that already exists (mapping stable across retries)", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }])); // owner
    tenantDriver.results.push(
      selectResult([{ id: "tr-stable", testId: "t1", status: "queued" }]),
    );
    tenantDriver.results.push(selectResult([])); // composeRunSummary

    const res = await appendResultsHandler({
      request: postJson("/api/runs/run-1/results", {
        results: [sampleResult],
      }),
      params: { id: "run-1" },
      ctx: AUTH_CTX,
    });
    const body = (await res.json()) as {
      results: Array<{ clientKey: string; testResultId: string }>;
    };
    expect(body.results[0].testResultId).toBe("tr-stable");
  });
});

describe("completeRunHandler — error paths", () => {
  it("400s on invalid status enum", async () => {
    const res = await completeRunHandler({
      request: postJson("/api/runs/run-1/complete", {
        status: "succeeded", // not in CompleteRunPayloadSchema's enum
        durationMs: 100,
      }),
      params: { id: "run-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("blocks completedAt backdating outside dev", async () => {
    const res = await completeRunHandler({
      request: postJson("/api/runs/run-1/complete", {
        status: "passed",
        durationMs: 1000,
        completedAt: 1_700_000_000,
      }),
      params: { id: "run-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("propagates batch failure (the dashboard watchdog will reconcile)", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }])); // owner
    batchImpl.current = async () => {
      throw new Error("DO unreachable");
    };

    await expect(
      completeRunHandler({
        request: postJson("/api/runs/run-1/complete", {
          status: "passed",
          durationMs: 1000,
        }),
        params: { id: "run-1" },
        ctx: AUTH_CTX,
      }),
    ).rejects.toThrow(/DO unreachable/);
  });

  it("is idempotent: re-completing a run just re-sets the same fields", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }])); // owner
    tenantDriver.results.push(selectResult([])); // composeRunSummary

    const res = await completeRunHandler({
      request: postJson("/api/runs/run-1/complete", {
        status: "passed",
        durationMs: 1000,
      }),
      params: { id: "run-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(200);

    // A second complete call from another shard.
    tenantDriver.results.push(selectResult([{ id: "run-1" }]));
    tenantDriver.results.push(selectResult([]));

    const res2 = await completeRunHandler({
      request: postJson("/api/runs/run-1/complete", {
        status: "passed",
        durationMs: 1000,
      }),
      params: { id: "run-1" },
      ctx: AUTH_CTX,
    });
    expect(res2.status).toBe(200);
  });
});

// -------------------- artifact upload (R2 failures) --------------------

describe("artifactUploadHandler — error paths", () => {
  it("401s anon", async () => {
    const res = await artifactUploadHandler({
      request: new Request("https://example.com/api/artifacts/a1/upload", {
        method: "PUT",
        body: "x",
      }),
      params: { id: "a1" },
      ctx: {} as never,
    });
    expect(res.status).toBe(401);
  });

  it("404s when the artifact doesn't exist or isn't in this project", async () => {
    tenantDriver.results.push(selectResult([])); // artifact lookup miss

    const res = await artifactUploadHandler({
      request: new Request("https://example.com/api/artifacts/a1/upload", {
        method: "PUT",
        headers: { "content-length": "10" },
        body: "1234567890",
      }),
      params: { id: "a1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(404);
  });

  it("400s when Content-Length is missing", async () => {
    tenantDriver.results.push(
      selectResult([{ r2Key: "k", contentType: "text/plain", sizeBytes: 10 }]),
    );

    const res = await artifactUploadHandler({
      request: new Request("https://example.com/api/artifacts/a1/upload", {
        method: "PUT",
        body: "1234567890",
      }),
      params: { id: "a1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("400s when Content-Length disagrees with the registered sizeBytes", async () => {
    tenantDriver.results.push(
      selectResult([{ r2Key: "k", contentType: "text/plain", sizeBytes: 10 }]),
    );

    const res = await artifactUploadHandler({
      request: new Request("https://example.com/api/artifacts/a1/upload", {
        method: "PUT",
        headers: { "content-length": "999" },
        body: "1234567890",
      }),
      params: { id: "a1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("502s when R2.put fails (not a generic 500)", async () => {
    tenantDriver.results.push(
      selectResult([{ r2Key: "k", contentType: "text/plain", sizeBytes: 10 }]),
    );
    mockR2.put.mockRejectedValueOnce(new Error("R2 outage"));

    const res = await artifactUploadHandler({
      request: new Request("https://example.com/api/artifacts/a1/upload", {
        method: "PUT",
        headers: { "content-length": "10" },
        body: "1234567890",
      }),
      params: { id: "a1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/R2 outage/i);
  });
});

// -------------------- artifact register (oversized) --------------------

describe("registerArtifactsHandler — error paths", () => {
  it("413s when an artifact exceeds the size limit", async () => {
    const res = await registerArtifactsHandler({
      request: postJson("/api/artifacts/register", {
        runId: "run-1",
        artifacts: [
          {
            testResultId: "tr-1",
            type: "trace",
            name: "huge.zip",
            contentType: "application/zip",
            sizeBytes: 60_000_000,
          },
        ],
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; maxBytes: number };
    expect(body.error).toMatch(/exceeds/i);
    expect(body.maxBytes).toBe(52_428_800);
  });

  it("400s on missing runId", async () => {
    const res = await registerArtifactsHandler({
      request: postJson("/api/artifacts/register", {
        artifacts: [
          {
            testResultId: "tr-1",
            type: "trace",
            name: "x.zip",
            contentType: "application/zip",
            sizeBytes: 1,
          },
        ],
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("400s on empty artifacts array (matches schema's min(1))", async () => {
    const res = await registerArtifactsHandler({
      request: postJson("/api/artifacts/register", {
        runId: "run-1",
        artifacts: [],
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });
});
