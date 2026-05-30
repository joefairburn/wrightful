import { defineHandler, type InferProps } from "void";
import { db, eq } from "void/db";
import { ulid } from "ulid";
import { projects } from "@schema";
import { mutationErrorMessage } from "@/lib/action-errors";
import { readField } from "@/lib/form";
import { requireOwnerScope } from "@/lib/settings-scope";

export type Props = InferProps<typeof loader>;

const SLUG_MAX_LEN = 40;

const hereFor = (team: { slug: string }) =>
  `/settings/teams/${team.slug}/projects/new`;

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
  const { team } = await requireOwnerScope(c, hereFor);
  const error = new URL(c.req.url).searchParams.get("error");
  return { team, error };
});

/**
 * Settings → New project action. Owner-only. Same slug-derivation strategy
 * as team creation; uniqueness is scoped to the team (the schema enforces
 * `(teamId, slug)` uniqueness).
 */
export const action = defineHandler(async (c) => {
  const { team, here: formUrl } = await requireOwnerScope(c, hereFor);

  const form = await c.req.formData();
  const name = readField(form, "name").trim();

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
    const friendly = mutationErrorMessage(err, {
      context: "create project failed",
      uniqueMessage: "Could not create project — please try again.",
      genericMessage: "Could not create project.",
    });
    return c.redirect(`${formUrl}?error=${encodeURIComponent(friendly)}`);
  }

  return c.redirect(`/settings/teams/${team.slug}`);
});
