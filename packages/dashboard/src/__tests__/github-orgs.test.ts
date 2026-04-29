/**
 * Tests for the GitHub-org-gated team-access feature. Covers two things we
 * can't regress quietly: the org-list fetch must correctly bucket GitHub's
 * ambiguous error responses (401 vs 403 vs scope-missing), and the join
 * handler must re-verify org membership at the action boundary rather than
 * trusting the cache.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/control", () => ({ getControlDb: () => dbRef.current }));
vi.mock("ulid", () => ({ ulid: () => "membership-01" }));

import { fetchUserOrgsFromGithub, hasReadOrgScope } from "../lib/github-orgs";
import * as githubOrgs from "../lib/github-orgs";
import { joinTeamHandler } from "../routes/api/team-suggestions";
import {
  makeTestDb,
  selectResult,
  type ScriptedDriver,
} from "./helpers/test-db";

describe("hasReadOrgScope", () => {
  it("recognises the read:org scope in space- or comma-separated lists", () => {
    expect(hasReadOrgScope("read:org")).toBe(true);
    expect(hasReadOrgScope("user:email read:org")).toBe(true);
    expect(hasReadOrgScope("user:email,read:org")).toBe(true);
    expect(hasReadOrgScope("user:email")).toBe(false);
    expect(hasReadOrgScope(null)).toBe(false);
    expect(hasReadOrgScope(undefined)).toBe(false);
    expect(hasReadOrgScope("")).toBe(false);
  });
});

describe("fetchUserOrgsFromGithub", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns no_token when the access token is empty", async () => {
    const res = await fetchUserOrgsFromGithub(null);
    expect(res).toEqual({ kind: "no_token" });
  });

  it("returns the lowercased list of org logins on 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ login: "Acme" }, { login: "BETA" }]), {
        status: 200,
      }),
    ) as typeof fetch;
    const res = await fetchUserOrgsFromGithub("tok");
    expect(res).toEqual({ kind: "ok", orgs: ["acme", "beta"] });
  });

  it("classifies 403 + x-accepted-oauth-scopes missing read:org as scope_missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("nope", {
        status: 403,
        headers: {
          "x-accepted-oauth-scopes": "read:org",
          "x-oauth-scopes": "user:email",
        },
      }),
    ) as typeof fetch;
    const res = await fetchUserOrgsFromGithub("tok");
    expect(res).toEqual({ kind: "scope_missing" });
  });

  it("returns a generic error for 403 when the scope is already granted", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("nope", {
        status: 403,
        headers: {
          "x-accepted-oauth-scopes": "read:org",
          "x-oauth-scopes": "read:org user:email",
        },
      }),
    ) as typeof fetch;
    const res = await fetchUserOrgsFromGithub("tok");
    expect(res).toEqual({ kind: "error", status: 403 });
  });

  it("returns a generic error for 401 (bad token)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("bad token", { status: 401 }),
      ) as typeof fetch;
    const res = await fetchUserOrgsFromGithub("tok");
    expect(res).toEqual({ kind: "error", status: 401 });
  });
});

describe("joinTeamHandler", () => {
  const refreshSpy = vi.spyOn(githubOrgs, "refreshUserOrgs");
  let driver: ScriptedDriver;

  beforeEach(() => {
    const t = makeTestDb();
    dbRef.current = t.db;
    driver = t.driver;
    refreshSpy.mockReset();
  });

  function call(): Promise<Response> {
    const ctx = { user: { id: "user-1" } } as unknown as Parameters<
      typeof joinTeamHandler
    >[0]["ctx"];
    return joinTeamHandler({
      request: new Request("https://example.com/t/acme/join", {
        method: "POST",
      }),
      ctx,
      params: { teamSlug: "acme" },
    });
  }

  it("404s when the team doesn't exist", async () => {
    driver.results.push(selectResult([]));
    const res = await call();
    expect(res.status).toBe(404);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("redirects without re-checking GitHub when the user is already a member", async () => {
    driver.results.push(
      selectResult([{ id: "team-1", slug: "acme", githubOrgSlug: "acme" }]),
      selectResult([{ id: "existing-membership" }]),
    );
    const res = await call();
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://example.com/t/acme");
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("403s when the team's github_org_slug isn't in the user's live org list", async () => {
    driver.results.push(
      selectResult([{ id: "team-1", slug: "acme", githubOrgSlug: "acme" }]),
      selectResult([]), // not a member
    );
    refreshSpy.mockResolvedValueOnce({
      orgs: ["other"],
      scopeOk: true,
      kind: "ok",
    });
    const res = await call();
    expect(res.status).toBe(403);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // no membership insert
    expect(
      driver.queries.some((q) => /insert into "memberships"/i.test(q.sql)),
    ).toBe(false);
  });

  it("re-fetches the user's orgs and inserts membership when eligible", async () => {
    driver.results.push(
      selectResult([{ id: "team-1", slug: "acme", githubOrgSlug: "acme" }]),
      selectResult([]), // not a member
      selectResult([]), // insert result
      selectResult([]), // delete dismissal result
    );
    refreshSpy.mockResolvedValueOnce({
      orgs: ["acme"],
      scopeOk: true,
      kind: "ok",
    });
    const res = await call();
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://example.com/t/acme");
    const sqls = driver.queries.map((q) => q.sql);
    expect(sqls.some((s) => /insert into "memberships"/i.test(s))).toBe(true);
    expect(
      sqls.some((s) => /delete from "teamSuggestionDismissals"/i.test(s)),
    ).toBe(true);
  });

  it("compares the team's github org slug case-insensitively", async () => {
    driver.results.push(
      selectResult([{ id: "team-1", slug: "acme", githubOrgSlug: "Acme" }]),
      selectResult([]),
      selectResult([]),
      selectResult([]),
    );
    refreshSpy.mockResolvedValueOnce({
      orgs: ["acme"],
      scopeOk: true,
      kind: "ok",
    });
    const res = await call();
    expect(res.status).toBe(303);
  });

  it("rejects unauthenticated callers", async () => {
    const res = await joinTeamHandler({
      request: new Request("https://example.com/t/acme/join", {
        method: "POST",
      }),
      ctx: {} as unknown as Parameters<typeof joinTeamHandler>[0]["ctx"],
      params: { teamSlug: "acme" },
    });
    expect(res.status).toBe(401);
  });
});
