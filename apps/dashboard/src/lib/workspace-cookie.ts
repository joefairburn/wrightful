import type { Context } from "hono";

const COOKIE_NAME = "wf_workspace";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface WorkspaceCookie {
  teamSlug: string | null;
  projectSlug: string | null;
}

export function readWorkspaceCookie(c: Context): WorkspaceCookie {
  const header = c.req.header("Cookie") ?? null;
  if (!header) return { teamSlug: null, projectSlug: null };
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.split("=");
    if (!rawKey || rawKey.trim() !== COOKIE_NAME) continue;
    const value = rest.join("=").trim();
    const [team, project] = value.split(":");
    const teamSlug = team && SLUG_RE.test(team) ? team : null;
    const projectSlug = project && SLUG_RE.test(project) ? project : null;
    if (!teamSlug) return { teamSlug: null, projectSlug: null };
    return { teamSlug, projectSlug };
  }
  return { teamSlug: null, projectSlug: null };
}

export function setWorkspaceCookie(
  c: Context,
  teamSlug: string,
  projectSlug: string | null,
): void {
  const value = `${teamSlug}:${projectSlug ?? ""}`;
  c.header("Set-Cookie", buildCookie(value, COOKIE_MAX_AGE, isHttps(c)), {
    append: true,
  });
}

export function clearWorkspaceCookie(c: Context): void {
  c.header("Set-Cookie", buildCookie("", 0, isHttps(c)), { append: true });
}

function buildCookie(value: string, maxAge: number, https: boolean): string {
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
  ];
  if (https) attrs.push("Secure");
  return attrs.join("; ");
}

function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}
