/**
 * Auth + scoping coverage for `setLastTeamHandler` / `setLastProjectHandler`.
 * Focus: 401/400/404 boundaries and that membership resolution is honoured
 * before any persistence call lands.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbRef, bundleRef, setLastTeamMock, setLastProjectMock } = vi.hoisted(
  () => ({
    dbRef: { current: null as unknown },
    bundleRef: {
      current: {
        userTeams: [],
        activeTeam: null,
        teamProjects: [],
        activeProject: null,
      } as Record<string, unknown>,
    },
    setLastTeamMock: vi.fn(async () => {}),
    setLastProjectMock: vi.fn(async () => {}),
  }),
);

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/control", () => ({
  getControlDb: () => dbRef.current,
}));
vi.mock("@/lib/authz", () => ({
  resolveTenantBundleForUser: vi.fn(async () => bundleRef.current),
}));
vi.mock("@/lib/user-state", () => ({
  setLastTeam: setLastTeamMock,
  setLastProject: setLastProjectMock,
}));

import { makeTestDb } from "./helpers/test-db";
import {
  setLastProjectHandler,
  setLastTeamHandler,
} from "../routes/api/user-state";

const SIGNED_IN = { user: { id: "user-1" } };
const ANON = {};

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
  dbRef.current = control.db;
  bundleRef.current = {
    userTeams: [],
    activeTeam: null,
    teamProjects: [],
    activeProject: null,
  };
});

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
