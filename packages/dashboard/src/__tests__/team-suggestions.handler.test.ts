/**
 * Auth + scoping coverage for the team-suggestions handlers (join, dismiss,
 * undismiss). The join path additionally enforces a live GitHub-org check
 * and is the most security-sensitive of the three.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbRef, refreshOrgsMock } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  refreshOrgsMock: vi.fn(async () => ({ orgs: [] as string[] })),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/control", () => ({
  getControlDb: () => dbRef.current,
}));
vi.mock("@/lib/github-orgs", () => ({
  refreshUserOrgs: refreshOrgsMock,
}));
vi.mock("ulid", () => ({ ulid: () => "membership-01" }));

import {
  makeTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";
import {
  dismissSuggestionHandler,
  joinTeamHandler,
  undismissSuggestionHandler,
} from "../routes/api/team-suggestions";

const SIGNED_IN = { user: { id: "user-1" } };
const ANON = {};

let controlDriver: ScriptedDriver;

beforeEach(() => {
  vi.clearAllMocks();
  const control = makeTestDb();
  controlDriver = control.driver;
  dbRef.current = control.db;
  refreshOrgsMock.mockResolvedValue({ orgs: [] });
});

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
