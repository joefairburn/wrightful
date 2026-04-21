/**
 * Regression test for the tenant-scoping invariant documented in CLAUDE.md:
 * `RunDetailPage` must scope its `runs` lookup by `projectId` so a user
 * cannot load a run belonging to another project by guessing / replaying
 * a runId. Without the projectId filter this test fails loudly.
 *
 * Post-M3 + scope-capability, the page reads from the team's tenant DO
 * via `project.db`. `getActiveProject()` is mocked to return a scope over
 * a scripted Kysely — if the page forgot the `projectId` predicate, the
 * first compiled query wouldn't contain it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbRef, mockGetActiveProject, mockParam } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  mockGetActiveProject: vi.fn(),
  mockParam: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("rwsdk/worker", () => ({
  requestInfo: { request: new Request("http://localhost") },
}));
vi.mock("@/app/pages/not-found", () => ({ NotFoundPage: () => null }));
vi.mock("@/lib/active-project", () => ({
  getActiveProject: mockGetActiveProject,
}));
vi.mock("@/lib/route-params", () => ({ param: mockParam }));
vi.mock("@/routes/api/progress", () => ({
  composeRunProgress: vi.fn().mockResolvedValue(null),
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
import { RunDetailPage } from "../app/pages/run-detail";

let driver: ScriptedDriver;

describe("RunDetailPage tenant scoping", () => {
  beforeEach(() => {
    const t = makeTenantTestDb();
    dbRef.current = t.db;
    driver = t.driver;
    mockParam.mockReturnValue("run-cross-project");
    mockGetActiveProject.mockResolvedValue({
      id: "project-current",
      projectId: "project-current",
      projectSlug: "web",
      teamId: "team-current",
      teamSlug: "acme",
      teamName: "Acme",
      slug: "web",
      name: "Web",
      db: t.db,
      batch: async () => {},
    });
  });

  it("scopes the runs lookup by both runId and projectId", async () => {
    driver.results.push(selectResult([]));
    await RunDetailPage();

    expect(driver.queries.length).toBeGreaterThanOrEqual(1);
    const first = driver.queries[0];
    expect(first.sql).toMatch(/from "runs"/i);
    expect(first.sql).toMatch(/"id"\s*=\s*\?/);
    expect(first.sql).toMatch(/"projectId"\s*=\s*\?/);
    expect(first.sql).toMatch(/"committed"\s*=\s*\?/);
    expect(first.parameters).toEqual(
      expect.arrayContaining(["run-cross-project", "project-current"]),
    );
  });

  it("404s without a second query when runs returns empty", async () => {
    driver.results.push(selectResult([]));
    await RunDetailPage();
    expect(driver.queries.length).toBe(1);
  });
});
