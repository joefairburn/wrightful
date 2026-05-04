/**
 * Auth + scoping coverage for the API route handlers that previously had
 * none: user-state (setLast{Team,Project}), test-result-summary,
 * run-test-preview, and team-suggestions (join, dismiss, undismiss).
 *
 * Focus: 401/404/400 boundaries, project scoping (no cross-tenant reads),
 * and the GitHub-org gate on team join. Heavy SQL shape assertions live in
 * the per-feature unit tests; these are about request → response correctness.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Compilable } from "kysely";

const {
  dbRef,
  tenantDbRef,
  bundleRef,
  refreshOrgsMock,
  setLastTeamMock,
  setLastProjectMock,
} = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  tenantDbRef: { current: null as unknown },
  bundleRef: {
    current: {
      userTeams: [],
      activeTeam: null,
      teamProjects: [],
      activeProject: null,
    } as Record<string, unknown>,
  },
  refreshOrgsMock: vi.fn(async () => ({ orgs: [] as string[] })),
  setLastTeamMock: vi.fn(async () => {}),
  setLastProjectMock: vi.fn(async () => {}),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/control", () => ({
  getControlDb: () => dbRef.current,
}));
vi.mock("@/lib/authz", () => ({
  resolveTenantBundleForUser: vi.fn(async () => bundleRef.current),
}));
vi.mock("@/lib/github-orgs", () => ({
  refreshUserOrgs: refreshOrgsMock,
}));
vi.mock("@/lib/user-state", () => ({
  setLastTeam: setLastTeamMock,
  setLastProject: setLastProjectMock,
}));
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
vi.mock("ulid", () => ({ ulid: () => "membership-01" }));

import {
  makeTenantTestDb,
  makeTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";
import {
  setLastProjectHandler,
  setLastTeamHandler,
} from "../routes/api/user-state";
import { testResultSummaryHandler } from "../routes/api/test-result-summary";
import { runTestPreviewHandler } from "../routes/api/run-test-preview";
import {
  dismissSuggestionHandler,
  joinTeamHandler,
  undismissSuggestionHandler,
} from "../routes/api/team-suggestions";

const SIGNED_IN = { user: { id: "user-1" } };
const ANON = {};

let controlDriver: ScriptedDriver;
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
  controlDriver = control.driver;
  dbRef.current = control.db;
  const tenant = makeTenantTestDb();
  tenantDriver = tenant.driver;
  tenantDbRef.current = tenant.db;
  bundleRef.current = {
    userTeams: [],
    activeTeam: null,
    teamProjects: [],
    activeProject: null,
  };
  refreshOrgsMock.mockResolvedValue({ orgs: [] });
});

// -------------------- user-state --------------------

describe("setLastTeamHandler", () => {
  it("401s anon", async () => {
    const res = await setLastTeamHandler({
      request: postJson("/api/user-state/last-team", { teamSlug: "acme" }),
      ctx: ANON as never,
    });
    expect(res.status).toBe(401);
  });

  it("400s on invalid body", async () => {
    const res = await setLastTeamHandler({
      request: postJson("/api/user-state/last-team", {}),
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(400);
  });

  it("404s when the user isn't a member of the team", async () => {
    bundleRef.current = {
      userTeams: [],
      activeTeam: null,
      teamProjects: [],
      activeProject: null,
    };
    const res = await setLastTeamHandler({
      request: postJson("/api/user-state/last-team", { teamSlug: "ghost" }),
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(404);
    expect(setLastTeamMock).not.toHaveBeenCalled();
  });

  it("204s and persists when the user is a member", async () => {
    bundleRef.current = {
      userTeams: [{ slug: "acme", name: "Acme" }],
      activeTeam: { id: "team-1", slug: "acme", name: "Acme", role: "owner" },
      teamProjects: [],
      activeProject: null,
    };
    const res = await setLastTeamHandler({
      request: postJson("/api/user-state/last-team", { teamSlug: "acme" }),
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(204);
    expect(setLastTeamMock).toHaveBeenCalledWith("user-1", "team-1");
  });
});

describe("setLastProjectHandler", () => {
  it("401s anon", async () => {
    const res = await setLastProjectHandler({
      request: postJson("/api/user-state/last-project", {
        teamSlug: "acme",
        projectSlug: "web",
      }),
      ctx: ANON as never,
    });
    expect(res.status).toBe(401);
  });

  it("400s when projectSlug is missing", async () => {
    const res = await setLastProjectHandler({
      request: postJson("/api/user-state/last-project", { teamSlug: "acme" }),
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(400);
  });

  it("404s when the project isn't visible to the user", async () => {
    bundleRef.current = {
      userTeams: [],
      activeTeam: null,
      teamProjects: [],
      activeProject: null,
    };
    const res = await setLastProjectHandler({
      request: postJson("/api/user-state/last-project", {
        teamSlug: "acme",
        projectSlug: "web",
      }),
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(404);
    expect(setLastProjectMock).not.toHaveBeenCalled();
  });

  it("204s and persists teamId + projectId on success", async () => {
    bundleRef.current = {
      userTeams: [],
      activeTeam: null,
      teamProjects: [],
      activeProject: { teamId: "team-1", id: "proj-1" },
    };
    const res = await setLastProjectHandler({
      request: postJson("/api/user-state/last-project", {
        teamSlug: "acme",
        projectSlug: "web",
      }),
      ctx: SIGNED_IN as never,
    });
    expect(res.status).toBe(204);
    expect(setLastProjectMock).toHaveBeenCalledWith(
      "user-1",
      "team-1",
      "proj-1",
    );
  });
});

// -------------------- test-result-summary --------------------

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

// -------------------- run-test-preview --------------------

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
    const body = await res.json();
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].id).toBe("f1");
    expect(body.flaky).toHaveLength(0);
    expect(body.passed[0].id).toBe("p1");
    expect(body.skipped).toHaveLength(0);
  });
});

// -------------------- team-suggestions --------------------

describe("joinTeamHandler", () => {
  const args = (over: Partial<{ teamSlug: string; ctx: unknown }> = {}) => ({
    request: new Request("https://example.com/api/teams/acme/join", {
      method: "POST",
    }),
    ctx: (over.ctx ?? SIGNED_IN) as never,
    params: { teamSlug: over.teamSlug ?? "acme" },
  });

  it("401s anon", async () => {
    const res = await joinTeamHandler(args({ ctx: ANON }));
    expect(res.status).toBe(401);
  });

  it("404s when the team slug is unknown", async () => {
    controlDriver.results.push(selectResult([])); // teams lookup
    const res = await joinTeamHandler(args());
    expect(res.status).toBe(404);
  });

  it("303s to /t/:slug when the user is already a member (idempotent)", async () => {
    controlDriver.results.push(
      selectResult([{ id: "team-1", slug: "acme", githubOrgSlug: "acme-inc" }]),
    );
    controlDriver.results.push(selectResult([{ id: "membership-existing" }]));

    const res = await joinTeamHandler(args());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://example.com/t/acme");
    expect(refreshOrgsMock).not.toHaveBeenCalled();
  });

  it("404s when the team has no githubOrgSlug (no auto-join path)", async () => {
    controlDriver.results.push(
      selectResult([{ id: "team-1", slug: "acme", githubOrgSlug: null }]),
    );
    controlDriver.results.push(selectResult([])); // no existing membership
    const res = await joinTeamHandler(args());
    expect(res.status).toBe(404);
    expect(refreshOrgsMock).not.toHaveBeenCalled();
  });

  it("403s when the user's live GitHub orgs don't include the team's org", async () => {
    controlDriver.results.push(
      selectResult([{ id: "team-1", slug: "acme", githubOrgSlug: "acme-inc" }]),
    );
    controlDriver.results.push(selectResult([])); // no membership
    refreshOrgsMock.mockResolvedValueOnce({ orgs: ["other-org"] });
    const res = await joinTeamHandler(args());
    expect(res.status).toBe(403);
  });

  it("inserts membership + clears dismissal when GitHub org matches, then 303s", async () => {
    controlDriver.results.push(
      selectResult([{ id: "team-1", slug: "acme", githubOrgSlug: "Acme-Inc" }]),
    );
    controlDriver.results.push(selectResult([])); // no membership
    refreshOrgsMock.mockResolvedValueOnce({ orgs: ["acme-inc", "globex"] });
    controlDriver.results.push(selectResult([])); // insert
    controlDriver.results.push(selectResult([])); // delete dismissal

    const res = await joinTeamHandler(args());
    expect(res.status).toBe(303);
    const insertQ = controlDriver.queries.find((q) =>
      q.sql.toLowerCase().startsWith("insert into"),
    );
    expect(insertQ).toBeDefined();
    expect(insertQ?.sql).toMatch(/"memberships"/);
    const deleteQ = controlDriver.queries.find((q) =>
      q.sql.toLowerCase().startsWith("delete from"),
    );
    expect(deleteQ?.sql).toMatch(/"teamSuggestionDismissals"/);
  });

  it("compares orgs case-insensitively (team slug 'Acme-Inc' vs cache 'acme-inc')", async () => {
    controlDriver.results.push(
      selectResult([{ id: "team-1", slug: "acme", githubOrgSlug: "Acme-Inc" }]),
    );
    controlDriver.results.push(selectResult([]));
    refreshOrgsMock.mockResolvedValueOnce({ orgs: ["acme-inc"] });
    controlDriver.results.push(selectResult([]));
    controlDriver.results.push(selectResult([]));

    const res = await joinTeamHandler(args());
    expect(res.status).toBe(303);
  });
});

describe("dismissSuggestionHandler", () => {
  it("401s anon", async () => {
    const res = await dismissSuggestionHandler({
      request: new Request("https://example.com/x", { method: "POST" }),
      ctx: ANON as never,
      params: { teamId: "t1" },
    });
    expect(res.status).toBe(401);
  });

  it("400s when teamId param is missing", async () => {
    const res = await dismissSuggestionHandler({
      request: new Request("https://example.com/x", { method: "POST" }),
      ctx: SIGNED_IN as never,
      params: {},
    });
    expect(res.status).toBe(400);
  });

  it("returns 204 for fetch callers (no Referer)", async () => {
    controlDriver.results.push(selectResult([]));
    const res = await dismissSuggestionHandler({
      request: new Request("https://example.com/x", { method: "POST" }),
      ctx: SIGNED_IN as never,
      params: { teamId: "t1" },
    });
    expect(res.status).toBe(204);
  });

  it("redirects (303) for browser form posts (same-origin Referer)", async () => {
    controlDriver.results.push(selectResult([]));
    const res = await dismissSuggestionHandler({
      request: new Request("https://example.com/x", {
        method: "POST",
        headers: { referer: "https://example.com/settings" },
      }),
      ctx: SIGNED_IN as never,
      params: { teamId: "t1" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://example.com/settings");
  });

  it("returns 204 (not redirect) for cross-origin Referer (no open redirect)", async () => {
    controlDriver.results.push(selectResult([]));
    const res = await dismissSuggestionHandler({
      request: new Request("https://example.com/x", {
        method: "POST",
        headers: { referer: "https://attacker.example/page" },
      }),
      ctx: SIGNED_IN as never,
      params: { teamId: "t1" },
    });
    expect(res.status).toBe(204);
  });

  it("upserts the dismissal row with current timestamp", async () => {
    controlDriver.results.push(selectResult([]));
    await dismissSuggestionHandler({
      request: new Request("https://example.com/x", { method: "POST" }),
      ctx: SIGNED_IN as never,
      params: { teamId: "t1" },
    });
    const upsert = controlDriver.queries[0];
    expect(upsert.sql).toMatch(/insert into\s+"teamSuggestionDismissals"/i);
    expect(upsert.sql).toMatch(/on conflict/i);
  });
});

describe("undismissSuggestionHandler", () => {
  it("401s anon", async () => {
    const res = await undismissSuggestionHandler({
      request: new Request("https://example.com/x", { method: "POST" }),
      ctx: ANON as never,
      params: { teamId: "t1" },
    });
    expect(res.status).toBe(401);
  });

  it("400s on missing teamId", async () => {
    const res = await undismissSuggestionHandler({
      request: new Request("https://example.com/x", { method: "POST" }),
      ctx: SIGNED_IN as never,
      params: {},
    });
    expect(res.status).toBe(400);
  });

  it("deletes the dismissal row scoped to userId + teamId", async () => {
    controlDriver.results.push(selectResult([]));
    const res = await undismissSuggestionHandler({
      request: new Request("https://example.com/x", { method: "POST" }),
      ctx: SIGNED_IN as never,
      params: { teamId: "t1" },
    });
    expect(res.status).toBe(204);
    const del = controlDriver.queries[0];
    expect(del.sql).toMatch(/delete from\s+"teamSuggestionDismissals"/i);
    expect(del.parameters).toEqual(expect.arrayContaining(["user-1", "t1"]));
  });
});
