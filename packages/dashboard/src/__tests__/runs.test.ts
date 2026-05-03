import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Compilable } from "kysely";

// Hoisted mutable refs. vi.hoisted can't `import` so we stash refs and
// populate them inside `beforeEach`.
const { tenantDbRef, batchCalls } = vi.hoisted(() => ({
  tenantDbRef: { current: null as unknown },
  batchCalls: [] as Array<{ teamId: string; queries: Compilable[] }>,
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/control", () => ({ getControlDb: vi.fn() }));
vi.mock("@/tenant", () => ({
  // Resolve the scope for API-key flows. Tests push their scripted
  // tenantDb into `tenantDbRef` before the handler runs.
  tenantScopeForApiKey: vi.fn(async (apiKey: { projectId: string } | null) => {
    if (!apiKey) return null;
    if (!tenantDbRef.current) return null;
    return {
      teamId: "team-1",
      teamSlug: "t",
      projectId: apiKey.projectId,
      projectSlug: "p",
      db: tenantDbRef.current,
      batch: async (queries: Compilable[]) => {
        batchCalls.push({ teamId: "team-1", queries: [...queries] });
      },
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
  openRunHandler,
  appendResultsHandler,
  completeRunHandler,
} from "../routes/api/runs";
import { getControlDb } from "@/control";

const mockedGetDb = vi.mocked(getControlDb);

const AUTH_CTX = {
  apiKey: { id: "key-1", label: "test", projectId: "proj-1" },
};

let tenantDriver: ScriptedDriver;

function makeRequest(url: string, body: unknown): Request {
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
  batchCalls.length = 0;
  mockedGetDb.mockReturnValue(control.db);
});

describe("openRunHandler", () => {
  it("401s without an API key", async () => {
    const res = await openRunHandler({
      request: makeRequest("/api/runs", { idempotencyKey: "k", run: {} }),
      ctx: {},
    });
    expect(res.status).toBe(401);
  });

  it("400s on invalid body", async () => {
    const res = await openRunHandler({
      request: makeRequest("/api/runs", { run: {} }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("creates a run when no idempotency match exists", async () => {
    tenantDriver.results.push(selectResult([])); // idempotency
    tenantDriver.results.push(selectResult([])); // broadcastRunUpdate: composeRunSummary runs row
    tenantDriver.results.push(selectResult([])); // broadcastRunUpdate: composeRunTestsTail testResults

    const res = await openRunHandler({
      request: makeRequest("/api/runs", {
        idempotencyKey: "ci-123",
        run: { reporterVersion: "0.1.0", playwrightVersion: "1.59.1" },
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string; runUrl: string };
    expect(body.runId).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.runUrl).toBe(`/t/t/p/p/runs/${body.runId}`);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].teamId).toBe("team-1");
    const compiledFirst = batchCalls[0].queries[0].compile();
    expect(compiledFirst.sql).toMatch(/insert\s+into\s+"runs"/i);
    expect(compiledFirst.parameters).toContain("running");
    expect(compiledFirst.parameters).toContain(body.runId);
  });

  it("returns the existing run on idempotency match", async () => {
    tenantDriver.results.push(selectResult([{ id: "existing-run" }]));

    const res = await openRunHandler({
      request: makeRequest("/api/runs", {
        idempotencyKey: "ci-123",
        run: {},
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; duplicate: boolean };
    expect(body.runId).toBe("existing-run");
    expect(body.duplicate).toBe(true);
    expect(batchCalls).toHaveLength(0);
  });
});

describe("appendResultsHandler", () => {
  it("404s when the run isn't owned by the caller's project", async () => {
    tenantDriver.results.push(selectResult([]));

    const res = await appendResultsHandler({
      request: makeRequest("/api/runs/run-x/results", {
        results: [
          {
            clientKey: "k1",
            testId: "t1",
            title: "a",
            file: "a.ts",
            status: "passed",
            durationMs: 10,
            retryCount: 0,
            tags: [],
            annotations: [],
            attempts: [
              {
                attempt: 0,
                status: "passed",
                durationMs: 10,
                errorMessage: null,
                errorStack: null,
              },
            ],
          },
        ],
      }),
      params: { id: "run-x" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(404);
  });

  it("401s when tenant scope can't be resolved", async () => {
    tenantDbRef.current = null;
    const res = await appendResultsHandler({
      request: makeRequest("/api/runs/run-x/results", {
        results: [
          {
            clientKey: "k1",
            testId: "t1",
            title: "a",
            file: "a.ts",
            status: "passed",
            durationMs: 10,
            retryCount: 0,
            tags: [],
            annotations: [],
            attempts: [
              {
                attempt: 0,
                status: "passed",
                durationMs: 10,
                errorMessage: null,
                errorStack: null,
              },
            ],
          },
        ],
      }),
      params: { id: "run-x" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(401);
  });

  it("batches inserts + aggregate recompute and returns mapping", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }]));
    tenantDriver.results.push(selectResult([])); // resolveTestResultIds
    tenantDriver.results.push(selectResult([])); // broadcastRunUpdate: composeRunSummary runs row
    tenantDriver.results.push(selectResult([])); // broadcastRunUpdate: composeRunTestsTail testResults

    const res = await appendResultsHandler({
      request: makeRequest("/api/runs/run-1/results", {
        results: [
          {
            clientKey: "k1",
            testId: "t1",
            title: "a",
            file: "a.ts",
            status: "passed",
            durationMs: 10,
            retryCount: 0,
            tags: ["smoke"],
            annotations: [{ type: "issue", description: "X" }],
            attempts: [
              {
                attempt: 0,
                status: "passed",
                durationMs: 10,
                errorMessage: null,
                errorStack: null,
              },
            ],
          },
          {
            clientKey: "k2",
            testId: "t2",
            title: "b",
            file: "a.ts",
            status: "failed",
            durationMs: 20,
            retryCount: 1,
            tags: [],
            annotations: [],
            attempts: [
              {
                attempt: 0,
                status: "failed",
                durationMs: 10,
                errorMessage: "first",
                errorStack: null,
              },
              {
                attempt: 1,
                status: "failed",
                durationMs: 10,
                errorMessage: "second",
                errorStack: null,
              },
            ],
          },
        ],
      }),
      params: { id: "run-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ clientKey: string; testResultId: string }>;
    };
    expect(body.results).toHaveLength(2);
    expect(body.results.map((r) => r.clientKey).sort()).toEqual(["k1", "k2"]);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].teamId).toBe("team-1");
    const stmts = batchCalls[0].queries;
    expect(stmts.length).toBeGreaterThanOrEqual(2);
    const last = stmts[stmts.length - 1].compile();
    expect(last.sql).toMatch(/update\s+"runs"/i);
  });
});

describe("completeRunHandler", () => {
  it("404s when the run isn't owned by the caller's project", async () => {
    tenantDriver.results.push(selectResult([]));
    const res = await completeRunHandler({
      request: makeRequest("/api/runs/run-x/complete", {
        status: "passed",
        durationMs: 1000,
      }),
      params: { id: "run-x" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(404);
  });

  it("updates status + completedAt and recomputes aggregates", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }]));
    tenantDriver.results.push(selectResult([])); // broadcastRunUpdate: composeRunSummary runs row
    tenantDriver.results.push(selectResult([])); // broadcastRunUpdate: composeRunTestsTail testResults

    const res = await completeRunHandler({
      request: makeRequest("/api/runs/run-1/complete", {
        status: "failed",
        durationMs: 1234,
      }),
      params: { id: "run-1" },
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("failed");
    expect(batchCalls).toHaveLength(1);
    const stmts = batchCalls[0].queries;
    expect(stmts.length).toBe(2);
    const first = stmts[0].compile();
    expect(first.sql).toMatch(/update\s+"runs"/i);
    expect(first.parameters).toContain("failed");
    expect(first.parameters).toContain(1234);
  });
});
