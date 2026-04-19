/**
 * Regression test for the tenant-scoping invariant documented in CLAUDE.md:
 * `RunDetailPage` must scope its `runs` lookup by `projectId` so a user
 * cannot load a run belonging to another project by guessing / replaying a
 * runId. Without the projectId filter this test fails loudly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";

type Row = Record<string, unknown>;

interface Chain {
  results: Row[][];
  whereCalls: unknown[][];
}

const { mockGetActiveProject, mockParam, chain } = vi.hoisted(() => {
  return {
    mockGetActiveProject: vi.fn(),
    mockParam: vi.fn(),
    chain: { results: [], whereCalls: [] } as Chain,
  };
});

vi.mock("rwsdk/worker", () => ({
  requestInfo: { request: new Request("http://localhost") },
}));
vi.mock("@/app/pages/not-found", () => ({ NotFoundPage: () => null }));
vi.mock("@/lib/active-project", () => ({
  getActiveProject: mockGetActiveProject,
}));
vi.mock("@/lib/route-params", () => ({ param: mockParam }));
vi.mock("@/db", () => ({
  getDb: () => {
    const thenable = {
      from: () => thenable,
      where: (clause: unknown) => {
        chain.whereCalls.push([clause]);
        return thenable;
      },
      limit: () => Promise.resolve(chain.results.shift() ?? []),
      then: (onFulfilled: (v: Row[]) => unknown) =>
        Promise.resolve(chain.results.shift() ?? []).then(onFulfilled),
    };
    return { select: () => thenable };
  },
}));

import { runs } from "@/db/schema";
import { RunDetailPage } from "../app/pages/run-detail";

describe("RunDetailPage tenant scoping", () => {
  beforeEach(() => {
    chain.results.length = 0;
    chain.whereCalls.length = 0;
    mockParam.mockReturnValue("run-cross-project");
    mockGetActiveProject.mockResolvedValue({
      id: "project-current",
      slug: "web",
      teamSlug: "acme",
    });
  });

  it("scopes the runs lookup by both runId and projectId", async () => {
    // runs query returns [] — simulates a runId that exists but belongs to
    // a different project.
    chain.results.push([]);

    await RunDetailPage();

    // The first drizzle .where() call is the runs lookup.
    expect(chain.whereCalls.length).toBeGreaterThanOrEqual(1);
    expect(chain.whereCalls[0][0]).toEqual(
      and(
        eq(runs.id, "run-cross-project"),
        eq(runs.projectId, "project-current"),
      ),
    );
  });

  it("404s without a second query when runs returns empty", async () => {
    chain.results.push([]);

    await RunDetailPage();

    // Only the runs query ran — the testResults query is gated behind the
    // `if (!run) return <NotFoundPage/>` short-circuit, so a missing /
    // cross-project run should never leak test rows.
    expect(chain.whereCalls.length).toBe(1);
  });
});
