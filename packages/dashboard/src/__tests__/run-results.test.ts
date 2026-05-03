import { describe, it, expect, vi, beforeEach } from "vitest";

const { tenantDbRef, scopeRef } = vi.hoisted(() => ({
  tenantDbRef: { current: null as unknown },
  scopeRef: {
    current: null as null | { teamId: string; projectId: string },
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/tenant", () => ({
  tenantScopeForUser: vi.fn(async (userId: string) => {
    if (!userId || !scopeRef.current || !tenantDbRef.current) return null;
    return {
      teamId: scopeRef.current.teamId,
      teamSlug: "t",
      projectId: scopeRef.current.projectId,
      projectSlug: "p",
      db: tenantDbRef.current,
      batch: async () => {},
    };
  }),
}));

import {
  makeTenantTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";
import { runResultsHandler } from "../routes/api/run-results";

let tenantDriver: ScriptedDriver;

const USER_CTX = {
  user: { id: "user-1", email: "u@x.com", name: "U", image: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  const tenant = makeTenantTestDb();
  tenantDriver = tenant.driver;
  tenantDbRef.current = tenant.db;
  scopeRef.current = { teamId: "team-1", projectId: "proj-1" };
});

function call(url: string, params: Record<string, string>) {
  return runResultsHandler({
    request: new Request(`https://example.com${url}`),
    params,
    ctx: USER_CTX,
  });
}

const PARAMS = { teamSlug: "t", projectSlug: "p", runId: "run-1" };

describe("runResultsHandler", () => {
  it("401s without a session user", async () => {
    const res = await runResultsHandler({
      request: new Request(
        "https://example.com/api/t/t/p/p/runs/run-1/results",
      ),
      params: PARAMS,
      ctx: {},
    });
    expect(res.status).toBe(401);
  });

  it("404s when the run is not in the caller's project", async () => {
    tenantDriver.results.push(selectResult([])); // owner check empty

    const res = await call("/api/t/t/p/p/runs/run-1/results", PARAMS);
    expect(res.status).toBe(404);
  });

  it("rejects an unknown status filter with 400", async () => {
    const res = await call(
      "/api/t/t/p/p/runs/run-1/results?status=invalid",
      PARAMS,
    );
    expect(res.status).toBe(400);
  });

  it("returns rows ordered DESC by (createdAt, id) with LIMIT+1 for cursor lookahead", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }]));
    tenantDriver.results.push(
      selectResult([
        {
          id: "tr-3",
          testId: "t3",
          title: "c",
          file: "x.ts",
          projectName: null,
          status: "passed",
          durationMs: 1,
          retryCount: 0,
          errorMessage: null,
          errorStack: null,
          createdAt: 300,
        },
        {
          id: "tr-2",
          testId: "t2",
          title: "b",
          file: "x.ts",
          projectName: null,
          status: "failed",
          durationMs: 1,
          retryCount: 0,
          errorMessage: null,
          errorStack: null,
          createdAt: 200,
        },
      ]),
    );

    const res = await call("/api/t/t/p/p/runs/run-1/results?limit=1", PARAMS);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      results: { id: string }[];
      nextCursor: string | null;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe("tr-3");
    expect(body.nextCursor).not.toBeNull();

    const lastQuery = tenantDriver.queries.at(-1);
    expect(lastQuery?.sql).toMatch(/order by\s+"createdAt"\s+desc/i);
    expect(lastQuery?.sql).toMatch(/limit\s+\?/i);
    // limit + 1 is the lookahead
    expect(lastQuery?.parameters).toContain(2);
  });

  it("scopes the query by runId+projectId via the tenant scope", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }]));
    tenantDriver.results.push(selectResult([]));

    await call("/api/t/t/p/p/runs/run-1/results", PARAMS);

    const ownerQuery = tenantDriver.queries[0];
    expect(ownerQuery?.parameters).toContain("run-1");
    expect(ownerQuery?.parameters).toContain("proj-1");
  });

  it("decodes a cursor and applies a (createdAt, id) tuple comparator", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }]));
    tenantDriver.results.push(selectResult([]));

    const cursor = btoa("250:tr-9");
    await call(
      `/api/t/t/p/p/runs/run-1/results?cursor=${encodeURIComponent(cursor)}`,
      PARAMS,
    );

    const rowsQuery = tenantDriver.queries.at(-1);
    expect(rowsQuery?.parameters).toContain(250);
    expect(rowsQuery?.parameters).toContain("tr-9");
  });

  it("returns nextCursor=null when fewer than limit+1 rows come back", async () => {
    tenantDriver.results.push(selectResult([{ id: "run-1" }]));
    tenantDriver.results.push(
      selectResult([
        {
          id: "tr-1",
          testId: "t1",
          title: "a",
          file: "x.ts",
          projectName: null,
          status: "passed",
          durationMs: 1,
          retryCount: 0,
          errorMessage: null,
          errorStack: null,
          createdAt: 100,
        },
      ]),
    );

    const res = await call("/api/t/t/p/p/runs/run-1/results?limit=10", PARAMS);
    const body = (await res.json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBeNull();
  });
});
