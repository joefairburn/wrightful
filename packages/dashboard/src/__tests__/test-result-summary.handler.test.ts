/**
 * Auth + scoping coverage for `testResultSummaryHandler`.
 * Confirms the SELECT is project-scoped (no cross-tenant leak), 401/404
 * boundaries hold, and the success response carries a private cache header.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Compilable } from "kysely";

const { tenantDbRef } = vi.hoisted(() => ({
  tenantDbRef: { current: null as unknown },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/tenant", () => ({
  tenantScopeForUser: vi.fn(async (userId, teamSlug, projectSlug) => {
    if (!tenantDbRef.current) return null;
    return {
      teamId: "team-1",
      teamSlug,
      projectId: "proj-1",
      projectSlug,
      db: tenantDbRef.current,
      batch: async (_q: Compilable[]) => {},
    };
  }),
}));

import {
  makeTenantTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";
import { testResultSummaryHandler } from "../routes/api/test-result-summary";

const SIGNED_IN = { user: { id: "user-1" } };
const ANON = {};

let tenantDriver: ScriptedDriver;

beforeEach(() => {
  vi.clearAllMocks();
  const tenant = makeTenantTestDb();
  tenantDriver = tenant.driver;
  tenantDbRef.current = tenant.db;
});

describe("testResultSummaryHandler", () => {
  const params = {
    teamSlug: "acme",
    projectSlug: "web",
    runId: "run-1",
    testResultId: "tr-1",
  };

  it("401s anon", async () => {
    const res = await testResultSummaryHandler({
      request: new Request("https://example.com/x"),
      params,
      ctx: ANON as never,
    });
    expect(res.status).toBe(401);
  });

  it("404s when the user can't access the project (membership check fails)", async () => {
    tenantDbRef.current = null;
    const res = await testResultSummaryHandler({
      request: new Request("https://example.com/x"),
      params,
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(404);
  });

  it("404s when the testResult row doesn't exist", async () => {
    tenantDriver.results.push(selectResult([]));
    const res = await testResultSummaryHandler({
      request: new Request("https://example.com/x"),
      params,
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(404);
  });

  it("scopes the SELECT by projectId so cross-tenant rows can't leak", async () => {
    tenantDriver.results.push(selectResult([]));
    await testResultSummaryHandler({
      request: new Request("https://example.com/x"),
      params,
      ctx: SIGNED_IN as never,
    });
    const q = tenantDriver.queries[0];
    expect(q.parameters).toContain("proj-1");
    expect(q.parameters).toContain("run-1");
    expect(q.parameters).toContain("tr-1");
  });

  it("returns the row + sets a private cache header", async () => {
    tenantDriver.results.push(
      selectResult([
        {
          id: "tr-1",
          runId: "run-1",
          status: "passed",
          durationMs: 12,
          retryCount: 0,
          title: "x",
          file: "a.spec.ts",
          projectName: null,
          createdAt: 1_700_000_000,
          branch: "main",
          commitSha: "abc",
          commitMessage: "msg",
          actor: "joe",
        },
      ]),
    );
    const res = await testResultSummaryHandler({
      request: new Request("https://example.com/x"),
      params,
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/private/);
    const body = await res.json();
    expect(body).toMatchObject({ id: "tr-1", branch: "main" });
  });
});
