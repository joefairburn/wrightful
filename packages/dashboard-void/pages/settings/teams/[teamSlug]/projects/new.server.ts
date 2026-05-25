import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { db, eq } from "void/db";
import { ulid } from "ulid";
import { projects } from "@schema";
import { requireTeamOwner } from "@/lib/authz";
import { readField } from "@/lib/form";

export type Props = InferProps<typeof loader>;

const SLUG_MAX_LEN = 40;

function slugifyName(name: string): string | null {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/, "");
  return base.length >= 1 ? base : null;
}

function pickUniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i <= 999; i++) {
    const suffix = `-${i}`;
    const trimmed = base
      .slice(0, SLUG_MAX_LEN - suffix.length)
      .replace(/-+$/, "");
    const candidate = `${trimmed}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Extremely unlikely — fall back to a random suffix; insert will still
  // reject on collision and the user will see a retry error.
  return `${base.slice(0, SLUG_MAX_LEN - 7).replace(/-+$/, "")}-${ulid().slice(-6).toLowerCase()}`;
}

/**
 * Settings → New project loader. Owner-only. The page only renders a single
 * form, so the loader's only job is verifying access + carrying flash error
 * state forward via `?error=...`.
 */
export const loader = defineHandler(async (c) => {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  let team: { id: string; slug: string; name: string };
  try {
    team = await requireTeamOwner(user.id, teamSlug);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }
  const error = new URL(c.req.url).searchParams.get("error");
  return { team, error };
});

/**
 * Settings → New project action. Owner-only. Same slug-derivation strategy
 * as team creation; uniqueness is scoped to the team (the schema enforces
 * `(teamId, slug)` uniqueness).
 */
export const action = defineHandler(async (c) => {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  let team: { id: string; slug: string; name: string };
  try {
    team = await requireTeamOwner(user.id, teamSlug);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }

  const form = await c.req.formData();
  const name = readField(form, "name").trim();
  const formUrl = `/settings/teams/${team.slug}/projects/new`;

  if (!name) {
    return c.redirect(
      `${formUrl}?error=${encodeURIComponent("Name is required.")}`,
    );
  }

  const baseSlug = slugifyName(name);
  if (!baseSlug) {
    return c.redirect(
      `${formUrl}?error=${encodeURIComponent(
        "Name must contain at least one letter or number.",
      )}`,
    );
  }

  const takenSlugs = new Set(
    (
      await db
        .select({ slug: projects.slug })
        .from(projects)
        .where(eq(projects.teamId, team.id))
    ).map((r) => r.slug),
  );
  const slug = pickUniqueSlug(baseSlug, takenSlugs);

  try {
    await db.insert(projects).values({
      id: ulid(),
      teamId: team.id,
      slug,
      name,
      createdAt: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const friendly = msg.includes("UNIQUE")
      ? "Could not create project — please try again."
      : "Could not create project.";
    return c.redirect(`${formUrl}?error=${encodeURIComponent(friendly)}`);
  }

  return c.redirect(`/settings/teams/${team.slug}`);
});
