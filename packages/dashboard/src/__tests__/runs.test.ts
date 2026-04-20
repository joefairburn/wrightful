import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ getDb: vi.fn() }));

import {
  openRunHandler,
  appendResultsHandler,
  completeRunHandler,
} from "../routes/api/runs";
import { getDb } from "@/db";

const mockedGetDb = vi.mocked(getDb);

const AUTH_CTX = {
  apiKey: { id: "key-1", label: "test", projectId: "proj-1" },
};

function makeRequest(url: string, body: unknown): Request {
  return new Request(`https://example.com${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface DbStub {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
  inserted: unknown[] | null;
  get batched(): unknown[] | null;
}

// Each call to `db.select()` consumes one row set from `selectResults`.
function makeDb(selectResults: unknown[][]): DbStub {
  const batchFn = vi.fn().mockResolvedValue(undefined);
  const state: DbStub = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    batch: batchFn,
    inserted: null,
    get batched() {
      const last = batchFn.mock.calls[batchFn.mock.calls.length - 1];
      return (last?.[0] as unknown[] | undefined) ?? null;
    },
  };
  state.update.mockImplementation(() => ({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ toSQL: () => ({}) }),
    }),
  }));
  state.delete.mockImplementation(() => ({
    where: vi.fn().mockReturnValue({ toSQL: () => ({}) }),
  }));
  state.select.mockImplementation(() => {
    const result = selectResults.shift() ?? [];
    // `.where(...)` in production can either be awaited directly (returns all
    // rows) or chained with `.limit(1)`. Make the stub thenable AND
    // .limit()-able so both call sites work.
    const whereReturn = {
      limit: vi.fn().mockResolvedValue(result),
      then: (resolve: (v: unknown) => unknown) => resolve(result),
    };
    return {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(whereReturn),
    };
  });
  state.insert.mockImplementation(() => ({
    values: vi.fn().mockImplementation((rows: unknown) => {
      state.inserted = Array.isArray(rows) ? rows : [rows];
      return Promise.resolve();
    }),
  }));
  return state;
}

function scope() {
  return [{ teamSlug: "t", projectSlug: "p" }];
}

describe("openRunHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s without an API key", async () => {
    mockedGetDb.mockReturnValue({} as never);
    const res = await openRunHandler({
      request: makeRequest("/api/runs", { idempotencyKey: "k", run: {} }),
      ctx: {},
    });
    expect(res.status).toBe(401);
  });

  it("400s on invalid body", async () => {
    mockedGetDb.mockReturnValue({} as never);
    const res = await openRunHandler({
      request: makeRequest("/api/runs", { run: {} }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("creates a run when no idempotency match exists", async () => {
    // scope select, then idempotency match select
    const db = makeDb([scope(), []]);
    mockedGetDb.mockReturnValue(db as never);
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
    const inserted = db.inserted as Array<Record<string, unknown>>;
    expect(inserted[0].status).toBe("running");
    expect(inserted[0].committed).toBe(true);
    expect(inserted[0].completedAt).toBe(null);
  });

  it("returns the existing run on idempotency match", async () => {
    const db = makeDb([scope(), [{ id: "existing-run" }]]);
    mockedGetDb.mockReturnValue(db as never);
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
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("appendResultsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("404s when the run isn't owned by the caller's project", async () => {
    const db = makeDb([[]]);
    mockedGetDb.mockReturnValue(db as never);
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

  it("batches inserts + aggregate recompute and returns mapping", async () => {
    // select order:
    //   1) owner lookup
    //   2) resolveTestResultIds existing-id query (empty → all fresh inserts)
    //   3) resolveProjectScope for broadcast
    //   4) composeRunProgress run row read (inside broadcast)
    //   5) composeRunProgress test_results read (inside broadcast)
    const db = makeDb([[{ id: "run-1" }], [], scope(), [], []]);
    mockedGetDb.mockReturnValue(db as never);
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
    // One batch was called, and the last statement is the aggregate recompute
    // (UPDATE runs). That's enough to confirm the shape without inspecting
    // drizzle's internal query objects.
    expect(db.batch).toHaveBeenCalledTimes(1);
    const stmts = db.batched as unknown[];
    expect(stmts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("completeRunHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("404s when the run isn't owned by the caller's project", async () => {
    const db = makeDb([[]]);
    mockedGetDb.mockReturnValue(db as never);
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
    const db = makeDb([[{ id: "run-1" }]]);
    mockedGetDb.mockReturnValue(db as never);
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
    expect(db.batch).toHaveBeenCalledTimes(1);
  });
});
