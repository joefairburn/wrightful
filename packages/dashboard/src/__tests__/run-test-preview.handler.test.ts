/**
 * Auth + scoping coverage for `runTestPreviewHandler`.
 * Each of the four bucket SELECTs (failed/flaky/passed/skipped) must be
 * scoped to the resolved projectId + runId + committed runs.
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
import { runTestPreviewHandler } from "../routes/api/run-test-preview";

const SIGNED_IN = { user: { id: "user-1" } };
const ANON = {};

let tenantDriver: ScriptedDriver;

beforeEach(() => {
  vi.clearAllMocks();
  const tenant = makeTenantTestDb();
  tenantDriver = tenant.driver;
  tenantDbRef.current = tenant.db;
});

describe("runTestPreviewHandler", () => {
  const params = { teamSlug: "acme", projectSlug: "web", runId: "run-1" };

  it("401s anon", async () => {
    const res = await runTestPreviewHandler({
      request: new Request("https://example.com/x"),
      params,
      ctx: ANON as never,
    });
    expect(res.status).toBe(401);
  });

  it("404s when scope resolution fails", async () => {
    tenantDbRef.current = null;
    const res = await runTestPreviewHandler({
      request: new Request("https://example.com/x"),
      params,
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(404);
  });

  it("issues 4 parallel SELECTs (one per bucket), each scoped to the project + committed runs", async () => {
    for (let i = 0; i < 4; i++) tenantDriver.results.push(selectResult([]));
    const res = await runTestPreviewHandler({
      request: new Request("https://example.com/x"),
      params,
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(200);
    expect(tenantDriver.queries).toHaveLength(4);
    for (const q of tenantDriver.queries) {
      expect(q.parameters).toContain("proj-1");
      expect(q.parameters).toContain("run-1");
      expect(q.parameters).toContain(1); // runs.committed = 1
    }
  });

  it("returns failed/flaky/passed/skipped buckets in stable order", async () => {
    tenantDriver.results.push(
      selectResult([
        {
          id: "f1",
          title: "fail-1",
          file: "a",
          projectName: null,
          status: "failed",
          errorMessage: null,
        },
      ]),
    );
    tenantDriver.results.push(selectResult([]));
    tenantDriver.results.push(
      selectResult([
        {
          id: "p1",
          title: "pass-1",
          file: "a",
          projectName: null,
          status: "passed",
          errorMessage: null,
        },
      ]),
    );
    tenantDriver.results.push(selectResult([]));

    const res = await runTestPreviewHandler({
      request: new Request("https://example.com/x"),
      params,
      ctx: SIGNED_IN as never,
    });
    const body = (await res.json()) as {
      failed: Array<{ id: string }>;
      flaky: unknown[];
      passed: Array<{ id: string }>;
      skipped: unknown[];
    };
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].id).toBe("f1");
    expect(body.flaky).toHaveLength(0);
    expect(body.passed[0].id).toBe("p1");
    expect(body.skipped).toHaveLength(0);
  });
});
