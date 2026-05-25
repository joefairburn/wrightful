import type { Context } from "hono";
import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { and, db, desc, eq, isNull, ne } from "void/db";
import { ulid } from "ulid";
import { apiKeys, projects, userState, type ApiKey } from "@schema";
import { resolveProjectBySlugs } from "@/lib/authz";
import { readField } from "@/lib/form";

export type Props = InferProps<typeof loader>;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const REVEAL_COOKIE = "wrightful_reveal_key";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateApiKey(): string {
  const rand = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...rand))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `wrf_${b64}`;
}

function readRevealCookie(c: Context): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === REVEAL_COOKIE) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function revealCookie(
  teamSlug: string,
  projectSlug: string,
  value: string | null,
): string {
  const path = `/settings/teams/${teamSlug}/p/${projectSlug}/keys`;
  const base = `${REVEAL_COOKIE}=${value ? encodeURIComponent(value) : ""}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
  return value ? `${base}; Max-Age=60` : `${base}; Max-Age=0`;
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

interface ProjectScope {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  teamSlug: string;
}

async function requireOwnedProject(
  c: Context,
): Promise<{ user: ReturnType<typeof requireAuth>; project: ProjectScope }> {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  const projectSlug = c.req.param("projectSlug");
  if (!teamSlug || !projectSlug) {
    throw new Response("Not Found", { status: 404 });
  }
  const project = await resolveProjectBySlugs(user.id, teamSlug, projectSlug);
  if (!project || project.role !== "owner") {
    throw new Response("Not Found", { status: 404 });
  }
  return {
    user,
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
    },
  };
}

/**
 * Settings → Project keys loader. Owner-only. Surfaces the project's keys,
 * the flash-revealed plaintext for a freshly-minted key (single-render), and
 * any per-section error messages stashed on the redirect.
 *
 * The plaintext lives in an HttpOnly, path-scoped flash cookie set by the
 * `create` action. We consume it here and immediately clear it so it can't
 * be re-displayed.
 */
export const loader = defineHandler(async (c) => {
  const { project } = await requireOwnedProject(c);

  const url = new URL(c.req.url);
  const generalError = url.searchParams.get("generalError");
  const dangerError = url.searchParams.get("dangerError");

  const revealedKey = readRevealCookie(c);
  if (revealedKey) {
    c.header("Set-Cookie", revealCookie(project.teamSlug, project.slug, null), {
      append: true,
    });
  }

  const keys = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.projectId, project.id))
    .orderBy(desc(apiKeys.createdAt));

  return {
    project,
    keys: keys as ApiKey[],
    revealedKey,
    generalError,
    dangerError,
  };
});

/**
 * Settings → Project keys mutations. One named action per concern, per
 * Void's documented convention. Forms target `<here>?actionName`.
 */
export const actions = {
  /**
   * Mint a key. Plaintext is reveal-once via an HttpOnly flash cookie
   * scoped to the keys page; the loader consumes + clears it on next render.
   */
  createKey: defineHandler(async (c) => {
    const { project, here } = await requireProjectScope(c);

    const form = await c.req.formData();
    const label = readField(form, "label").trim();
    if (!label) return c.redirect(here);
    const rawKey = generateApiKey();
    await db.insert(apiKeys).values({
      id: ulid(),
      projectId: project.id,
      label,
      keyHash: await sha256Hex(rawKey),
      keyPrefix: rawKey.slice(0, 8),
      createdAt: Math.floor(Date.now() / 1000),
      lastUsedAt: null,
      revokedAt: null,
    });
    c.header(
      "Set-Cookie",
      revealCookie(project.teamSlug, project.slug, rawKey),
      { append: true },
    );
    return c.redirect(here);
  }),

  /** Flip `revokedAt` on a non-revoked key. Idempotent. */
  revokeKey: defineHandler(async (c) => {
    const { project, here } = await requireProjectScope(c);

    const form = await c.req.formData();
    const keyId = readField(form, "keyId");
    if (!keyId) return c.redirect(here);
    await db
      .update(apiKeys)
      .set({ revokedAt: Math.floor(Date.now() / 1000) })
      .where(
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.projectId, project.id),
          isNull(apiKeys.revokedAt),
        ),
      );
    return c.redirect(here);
  }),

  /** Rename project or change slug. */
  updateGeneral: defineHandler(async (c) => {
    const { project, here } = await requireProjectScope(c);

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

    if (slug !== project.slug) {
      const clash = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.teamId, project.teamId),
            eq(projects.slug, slug),
            ne(projects.id, project.id),
          ),
        )
        .limit(1);
      if (clash[0]) {
        return redirectWithParam(
          c,
          here,
          "generalError",
          "That slug is already used by another project in this team.",
        );
      }
    }

    try {
      await db
        .update(projects)
        .set({ name, slug })
        .where(eq(projects.id, project.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const friendly = msg.includes("UNIQUE")
        ? "That slug is already used by another project in this team."
        : "Could not save changes.";
      return redirectWithParam(c, here, "generalError", friendly);
    }

    return c.redirect(`/settings/teams/${project.teamSlug}/p/${slug}/keys`);
  }),

  /** Delete project + its keys. */
  deleteProject: defineHandler(async (c) => {
    const { project, here } = await requireProjectScope(c);

    const form = await c.req.formData();
    const confirm = readField(form, "confirm").trim();
    if (confirm !== project.slug) {
      return redirectWithParam(
        c,
        here,
        "dangerError",
        `Confirmation did not match. Type "${project.slug}" exactly to delete the project.`,
      );
    }

    try {
      await db.batch([
        db.delete(apiKeys).where(eq(apiKeys.projectId, project.id)),
        db
          .update(userState)
          .set({ lastProjectId: null })
          .where(eq(userState.lastProjectId, project.id)),
        db.delete(projects).where(eq(projects.id, project.id)),
      ] as never);
    } catch {
      return redirectWithParam(
        c,
        here,
        "dangerError",
        "Could not delete project — please try again.",
      );
    }

    return c.redirect(`/settings/teams/${project.teamSlug}`);
  }),
};

async function requireProjectScope(
  c: Context,
): Promise<{ project: ProjectScope; here: string }> {
  const { project } = await requireOwnedProject(c);
  return {
    project,
    here: `/settings/teams/${project.teamSlug}/p/${project.slug}/keys`,
  };
}
