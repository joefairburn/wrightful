import type { Context } from "hono";
import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { and, db, desc, eq, gt, inArray, ne } from "void/db";
import { ulid } from "ulid";
import {
  apiKeys,
  memberships,
  projects,
  teamInvites,
  teams as teamsTable,
  userState,
} from "@schema";
import {
  requireTeamOwner,
  resolveTeamBySlug,
  type TeamRole,
} from "@/lib/authz";
import { readField } from "@/lib/form";
import { generateInviteToken, hashInviteToken } from "@/lib/invite-tokens";

export type Props = InferProps<typeof loader>;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// GitHub user login rules: alphanumeric + single hyphens, 1-39 chars,
// no leading/trailing hyphen, no consecutive hyphens. Same shape as orgs.
const GITHUB_LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
const INVITE_FLASH_COOKIE = "wrightful_invite_flash";
const INVITE_FLASH_MAX_AGE = 60;

type DirectedInvite =
  | { kind: "none" }
  | { kind: "email"; value: string }
  | { kind: "githubLogin"; value: string }
  | { kind: "invalid" };

function parseInviteIdentifier(raw: string): DirectedInvite {
  if (raw === "") return { kind: "none" };
  if (raw.includes("@")) {
    const value = raw.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { kind: "invalid" };
    return { kind: "email", value };
  }
  const value = raw.toLowerCase();
  if (!GITHUB_LOGIN_RE.test(value)) return { kind: "invalid" };
  return { kind: "githubLogin", value };
}

function readFlashCookie(
  cookieHeader: string | null,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.split("=");
    if (!rawKey) continue;
    if (rawKey.trim() !== name) continue;
    const rawValue = rest.join("=");
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return null;
    }
  }
  return null;
}

function buildInviteFlashCookie(
  value: string | null,
  path: string,
  isHttps: boolean,
): string {
  const attrs = [
    `${INVITE_FLASH_COOKIE}=${value === null ? "" : encodeURIComponent(value)}`,
    value === null ? "Max-Age=0" : `Max-Age=${INVITE_FLASH_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Strict",
    `Path=${path}`,
  ];
  if (isHttps) attrs.push("Secure");
  return attrs.join("; ");
}

interface MemberRow {
  userId: string;
  role: TeamRole;
  email: string;
  name: string;
  image: string | null;
}

export const loader = defineHandler(async (c) => {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  const team = await resolveTeamBySlug(user.id, teamSlug);
  if (!team) throw new Response("Not Found", { status: 404 });

  const url = new URL(c.req.url);
  const generalError = url.searchParams.get("generalError");
  const dangerError = url.searchParams.get("dangerError");
  const inviteError = url.searchParams.get("inviteError");
  const newInviteId = url.searchParams.get("newInvite");

  const [memberRowsRaw, projectRows, inviteRows] = await Promise.all([
    db.run({
      sql: `SELECT m.userId AS userId, m.role AS role, u.email AS email, u.name AS name, u.image AS image
              FROM memberships m
              INNER JOIN "user" u ON u.id = m.userId
              WHERE m.teamId = ?1`,
      params: [team.id],
    } as never),
    db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
      })
      .from(projects)
      .where(eq(projects.teamId, team.id))
      .orderBy(desc(projects.createdAt)),
    db
      .select({
        id: teamInvites.id,
        role: teamInvites.role,
        createdAt: teamInvites.createdAt,
        expiresAt: teamInvites.expiresAt,
        email: teamInvites.email,
        githubLogin: teamInvites.githubLogin,
      })
      .from(teamInvites)
      .where(
        and(
          eq(teamInvites.teamId, team.id),
          gt(teamInvites.expiresAt, Math.floor(Date.now() / 1000)),
        ),
      )
      .orderBy(desc(teamInvites.createdAt)),
  ]);

  const memberRows = (
    (memberRowsRaw.results ?? []) as Array<{
      userId: string;
      role: string;
      email: string;
      name: string;
      image: string | null;
    }>
  ).map(
    (r): MemberRow => ({
      userId: r.userId,
      role: r.role as TeamRole,
      email: r.email,
      name: r.name,
      image: r.image,
    }),
  );

  let shownInviteUrl: string | null = null;
  if (newInviteId) {
    const flash = readFlashCookie(
      c.req.header("Cookie") ?? null,
      INVITE_FLASH_COOKIE,
    );
    if (flash && inviteRows.some((i) => i.id === newInviteId)) {
      shownInviteUrl = flash;
      c.header(
        "Set-Cookie",
        buildInviteFlashCookie(
          null,
          `/settings/teams/${team.slug}`,
          url.protocol === "https:",
        ),
        { append: true },
      );
    }
  }

  return {
    team,
    members: memberRows,
    projects: projectRows,
    invites: inviteRows,
    generalError,
    dangerError,
    inviteError,
    shownInviteId: newInviteId,
    shownInviteUrl,
  };
});

/**
 * Settings → Team detail mutations. One named action per concern, per Void's
 * documented convention. Forms target `<teamHref>?actionName`; the `.tsx`
 * builds the URL with a literal query string instead of a hidden form field.
 */
export const actions = {
  /** Rename the team and/or change its URL slug. Redirects to new slug on success. */
  updateGeneral: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c);

    const form = await c.req.formData();
    const name = readField(form, "name").trim();
    const slug = readField(form, "slug").trim().toLowerCase();

    if (!name) {
      return redirectWithParam(c, here, "generalError", "Name is required.");
    }
    if (!SLUG_RE.test(slug)) {
      return redirectWithParam(
        c,
        here,
        "generalError",
        "Slug must be 1–40 lowercase alphanumerics and hyphens, starting and ending with a letter or number.",
      );
    }

    if (slug !== team.slug) {
      const clash = await db
        .select({ id: teamsTable.id })
        .from(teamsTable)
        .where(and(eq(teamsTable.slug, slug), ne(teamsTable.id, team.id)))
        .limit(1);
      if (clash[0]) {
        return redirectWithParam(
          c,
          here,
          "generalError",
          "That slug is already taken.",
        );
      }
    }

    try {
      await db
        .update(teamsTable)
        .set({ name, slug })
        .where(eq(teamsTable.id, team.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const friendly = msg.includes("UNIQUE")
        ? "That slug is already taken."
        : "Could not save changes.";
      return redirectWithParam(c, here, "generalError", friendly);
    }

    return c.redirect(`/settings/teams/${slug}`);
  }),

  /**
   * Mint a single-use invite (share-link only, or directed to an email /
   * GitHub login). Plaintext URL is reveal-once via an HttpOnly flash
   * cookie scoped to this team's settings path.
   */
  createInvite: defineHandler(async (c) => {
    const { team, here, user } = await requireOwnerScope(c);

    const form = await c.req.formData();
    const rawIdentifier = readField(form, "inviteIdentifier").trim();
    const directed = parseInviteIdentifier(rawIdentifier);
    if (directed.kind === "invalid") {
      return redirectWithParam(
        c,
        here,
        "inviteError",
        "Enter an email address or a GitHub username (letters, numbers, single hyphens).",
      );
    }

    const token = generateInviteToken();
    const tokenHash = await hashInviteToken(token);
    const inviteId = ulid();
    const nowSeconds = Math.floor(Date.now() / 1000);
    try {
      await db.insert(teamInvites).values({
        id: inviteId,
        teamId: team.id,
        tokenHash,
        role: "member",
        createdBy: user.id,
        createdAt: nowSeconds,
        expiresAt: nowSeconds + INVITE_TTL_SECONDS,
        email: directed.kind === "email" ? directed.value : null,
        githubLogin: directed.kind === "githubLogin" ? directed.value : null,
      });
    } catch {
      return redirectWithParam(
        c,
        here,
        "inviteError",
        "Could not create invite link — please try again.",
      );
    }
    const url = new URL(c.req.url);
    const inviteUrl = `${url.origin}/invite/${token}`;
    const flashCookie = buildInviteFlashCookie(
      inviteUrl,
      `/settings/teams/${team.slug}`,
      url.protocol === "https:",
    );
    c.header("Set-Cookie", flashCookie, { append: true });
    return c.redirect(`${here}?newInvite=${inviteId}`);
  }),

  /** Delete a pending invite by id. */
  revokeInvite: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c);

    const form = await c.req.formData();
    const inviteId = readField(form, "inviteId").trim();
    if (!inviteId) return c.redirect(here);
    try {
      await db
        .delete(teamInvites)
        .where(
          and(eq(teamInvites.id, inviteId), eq(teamInvites.teamId, team.id)),
        );
    } catch {
      return redirectWithParam(
        c,
        here,
        "inviteError",
        "Could not revoke invite link — please try again.",
      );
    }
    return c.redirect(here);
  }),

  /**
   * Permanently delete the team + all dependent rows. The form makes the
   * user type the team's slug as a confirmation gate.
   */
  deleteTeam: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c);

    const form = await c.req.formData();
    const confirm = readField(form, "confirm").trim();
    if (confirm !== team.slug) {
      return redirectWithParam(
        c,
        here,
        "dangerError",
        `Confirmation did not match. Type "${team.slug}" exactly to delete the team.`,
      );
    }

    const teamProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.teamId, team.id));
    const projectIds = teamProjects.map((r) => r.id);

    const ops: unknown[] = [];
    if (projectIds.length > 0) {
      ops.push(
        db.delete(apiKeys).where(inArray(apiKeys.projectId, projectIds)),
        db
          .update(userState)
          .set({ lastProjectId: null })
          .where(inArray(userState.lastProjectId, projectIds)),
      );
    }
    ops.push(
      db.delete(projects).where(eq(projects.teamId, team.id)),
      db.delete(memberships).where(eq(memberships.teamId, team.id)),
      db.delete(teamInvites).where(eq(teamInvites.teamId, team.id)),
      db
        .update(userState)
        .set({ lastTeamId: null })
        .where(eq(userState.lastTeamId, team.id)),
      db.delete(teamsTable).where(eq(teamsTable.id, team.id)),
    );

    try {
      await db.batch(ops as never);
    } catch {
      return redirectWithParam(
        c,
        here,
        "dangerError",
        "Could not delete team — please try again.",
      );
    }

    return c.redirect("/settings/profile");
  }),
};

/**
 * Common gate for every mutation: require auth + owner role on the URL's
 * team slug. Returns the resolved team + base URL each action uses for
 * redirect-with-error.
 */
async function requireOwnerScope(c: Context): Promise<{
  user: { id: string };
  team: { id: string; slug: string; name: string };
  here: string;
}> {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  let team: { id: string; slug: string; name: string };
  try {
    team = await requireTeamOwner(user.id, teamSlug);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }
  return { user: { id: user.id }, team, here: `/settings/teams/${team.slug}` };
}

function redirectWithParam(
  c: Context,
  base: string,
  key: string,
  value: string,
): Response {
  const url = new URL(base, "http://placeholder.local");
  url.searchParams.set(key, value);
  return c.redirect(`${url.pathname}${url.search}`);
}
