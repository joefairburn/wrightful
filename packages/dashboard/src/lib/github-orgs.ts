import { getControlDb } from "@/control";

export type GithubOrgsFetchResult =
  | { kind: "ok"; orgs: string[] }
  | { kind: "scope_missing" }
  | { kind: "no_token" }
  | { kind: "error"; status: number };

export interface CachedOrgs {
  orgs: string[];
  refreshedAt: number;
  scopeOk: boolean;
  stale: boolean;
}

export const ORG_CACHE_TTL_SECONDS = 30 * 60;
const REQUIRED_SCOPE = "read:org";

export async function fetchUserOrgsFromGithub(
  accessToken: string | null | undefined,
): Promise<GithubOrgsFetchResult> {
  if (!accessToken) return { kind: "no_token" };
  const res = await fetch("https://api.github.com/user/orgs?per_page=100", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "wrightful-dashboard",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 403 || res.status === 401) {
    const accepted = res.headers.get("x-accepted-oauth-scopes") ?? "";
    const granted = res.headers.get("x-oauth-scopes") ?? "";
    const needsReadOrg =
      accepted.includes(REQUIRED_SCOPE) && !granted.includes(REQUIRED_SCOPE);
    if (needsReadOrg) return { kind: "scope_missing" };
    return { kind: "error", status: res.status };
  }
  if (!res.ok) return { kind: "error", status: res.status };
  const body = (await res.json()) as { login: string }[];
  const orgs = body
    .map((o) => (typeof o.login === "string" ? o.login.toLowerCase() : null))
    .filter((x): x is string => Boolean(x));
  return { kind: "ok", orgs };
}

export async function getCachedUserOrgs(
  userId: string,
): Promise<CachedOrgs | null> {
  const db = getControlDb();
  const row = await db
    .selectFrom("userGithubOrgs")
    .select(["orgSlugsJson", "refreshedAt", "scopeOk"])
    .where("userId", "=", userId)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const orgs = parseOrgsJson(row.orgSlugsJson);
  const now = Math.floor(Date.now() / 1000);
  return {
    orgs,
    refreshedAt: row.refreshedAt,
    scopeOk: Boolean(row.scopeOk),
    stale: now - row.refreshedAt > ORG_CACHE_TTL_SECONDS,
  };
}

export interface RefreshOutcome {
  orgs: string[];
  scopeOk: boolean;
  kind: GithubOrgsFetchResult["kind"];
}

export async function refreshUserOrgs(userId: string): Promise<RefreshOutcome> {
  const db = getControlDb();
  const account = await db
    .selectFrom("account")
    .select(["accessToken", "scope"])
    .where("userId", "=", userId)
    .where("providerId", "=", "github")
    .limit(1)
    .executeTakeFirst();

  const result = await fetchUserOrgsFromGithub(account?.accessToken);
  const now = Math.floor(Date.now() / 1000);

  if (result.kind === "ok") {
    await upsertCache(userId, {
      orgSlugsJson: JSON.stringify(result.orgs),
      refreshedAt: now,
      scopeOk: 1,
    });
    return { orgs: result.orgs, scopeOk: true, kind: "ok" };
  }

  if (result.kind === "scope_missing") {
    await upsertCache(userId, {
      orgSlugsJson: "[]",
      refreshedAt: now,
      scopeOk: 0,
    });
    return { orgs: [], scopeOk: false, kind: "scope_missing" };
  }

  // no_token or transient error: don't overwrite a good cache with empty data.
  const existing = await getCachedUserOrgs(userId);
  if (existing) {
    return {
      orgs: existing.orgs,
      scopeOk: existing.scopeOk,
      kind: result.kind,
    };
  }
  return { orgs: [], scopeOk: false, kind: result.kind };
}

async function upsertCache(
  userId: string,
  values: { orgSlugsJson: string; refreshedAt: number; scopeOk: 0 | 1 },
): Promise<void> {
  const db = getControlDb();
  await db
    .insertInto("userGithubOrgs")
    .values({ userId, ...values })
    .onConflict((oc) =>
      oc.column("userId").doUpdateSet({
        orgSlugsJson: values.orgSlugsJson,
        refreshedAt: values.refreshedAt,
        scopeOk: values.scopeOk,
      }),
    )
    .execute();
}

function parseOrgsJson(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.toLowerCase());
  } catch {
    return [];
  }
}

export function hasReadOrgScope(scope: string | null | undefined): boolean {
  if (!scope) return false;
  return scope.split(/[\s,]+/).includes(REQUIRED_SCOPE);
}
