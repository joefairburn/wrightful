/**
 * Regression test for the tenant-scoping invariant documented in CLAUDE.md:
 * the `runs` lookup on the run-detail page must filter by both `runId` and
 * `projectId` so a user cannot load a run belonging to another project by
 * guessing / replaying a runId. Without the projectId filter this test
 * fails loudly.
 *
 * This tests `loadRun` directly — it's the helper that runs the
 * tenant-scoped query. The page-level orchestration around it (Suspense
 * loaders, streaming) is intentionally not exercised here; this test only
 * cares about the SQL contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks below short-circuit imports that would otherwise pull in
// rwsdk/worker's react-server-only entry (which throws outside RSC).
// The page module is imported only for `loadRun`; the rest stays inert.
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("rwsdk/worker", () => ({
  requestInfo: { request: new Request("http://localhost"), params: {} },
}));
vi.mock("@/app/pages/not-found", () => ({ NotFoundPage: () => null }));
vi.mock("@/lib/active-project", () => ({
  getActiveProject: vi.fn(),
}));
vi.mock("@/lib/route-params", () => ({ param: vi.fn() }));
vi.mock("@/routes/api/progress", () => ({
  composeRunProgressBatch: vi.fn().mockResolvedValue(new Map()),
  runRoomId: vi.fn(),
}));
vi.mock("@/lib/test-artifact-actions", () => ({
  loadFailingArtifactActions: vi.fn().mockResolvedValue({}),
}));

import {
  makeTenantTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";
import type { ActiveProject } from "@/lib/active-project";
import { loadRun } from "../app/pages/run-detail";

let driver: ScriptedDriver;
let project: ActiveProject;

describe("loadRun tenant scoping", () => {
  beforeEach(() => {
    const t = makeTenantTestDb();
    driver = t.driver;
    project = {
      id: "project-current",
      projectId: "project-current" as ActiveProject["projectId"],
      projectSlug: "web",
      teamId: "team-current" as ActiveProject["teamId"],
      teamSlug: "acme",
      teamName: "Acme",
      slug: "web",
      name: "Web",
      db: t.db,
      batch: async () => {},
    };
  });

  it("scopes the runs lookup by both runId and projectId", async () => {
    driver.results.push(selectResult([]));
    await loadRun(project, "run-cross-project");

    expect(driver.queries.length).toBe(1);
    const first = driver.queries[0];
    expect(first.sql).toMatch(/from "runs"/i);
    expect(first.sql).toMatch(/"id"\s*=\s*\?/);
    expect(first.sql).toMatch(/"projectId"\s*=\s*\?/);
    expect(first.sql).toMatch(/"committed"\s*=\s*\?/);
    expect(first.parameters).toEqual(
      expect.arrayContaining(["run-cross-project", "project-current"]),
    );
  });

  it("returns undefined when no row matches", async () => {
    driver.results.push(selectResult([]));
    const result = await loadRun(project, "run-cross-project");
    expect(result).toBeUndefined();
  });
});
