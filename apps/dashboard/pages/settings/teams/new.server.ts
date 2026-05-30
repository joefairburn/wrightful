import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { db, eq, like, or } from "void/db";
import { ulid } from "ulid";
import { memberships, teams as teamsTable } from "@schema";
import { runBatch } from "@/lib/db-batch";
import { mutationErrorMessage } from "@/lib/action-errors";
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
  return `${base.slice(0, SLUG_MAX_LEN - 7).replace(/-+$/, "")}-${ulid().slice(-6).toLowerCase()}`;
}

/**
 * Settings → New team loader. Renders the create-team form. Errors are
 * carried over from the action via the `?error=...` query string (same
 * convention used by the legacy rwsdk page so the wire shape doesn't shift).
 */
export const loader = defineHandler(async (c) => {
  requireAuth(c);
  const error = new URL(c.req.url).searchParams.get("error");
  return { error };
});

/**
 * Settings → New team action. Creates a team + owner membership atomically,
 * picks a unique slug derived from the requested name, then redirects to the
 * team's detail page.
 *
 * Slug picking strategy mirrors the rwsdk version: derive a base slug, fetch
 * collisions in one query, then walk -2 / -3 / ... until we find a free one.
 * Failure modes (empty name, slug exhaustion, unique violation) round-trip
 * the error through `?error=...` so the form re-renders with a message.
 */
export const action = defineHandler(async (c) => {
  const user = requireAuth(c);

  const form = await c.req.formData();
  const name = readField(form, "name").trim();
  const formUrl = "/settings/teams/new";

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

  const existingRows = await db
    .select({ slug: teamsTable.slug })
    .from(teamsTable)
    .where(
      or(eq(teamsTable.slug, baseSlug), like(teamsTable.slug, `${baseSlug}-%`)),
    );
  const taken = new Set(existingRows.map((r) => r.slug));
  const slug = pickUniqueSlug(baseSlug, taken);

  const teamId = ulid();
  const nowSeconds = Math.floor(Date.now() / 1000);
  try {
    await runBatch([
      db.insert(teamsTable).values({
        id: teamId,
        slug,
        name,
        createdAt: nowSeconds,
        lastActivityAt: null,
      }),
      db.insert(memberships).values({
        id: ulid(),
        userId: user.id,
        teamId,
        role: "owner",
        createdAt: nowSeconds,
      }),
    ]);
  } catch (err) {
    const friendly = mutationErrorMessage(err, {
      context: "create team failed",
      uniqueMessage: "Could not create team — please try again.",
      genericMessage: "Could not create team.",
    });
    return c.redirect(`${formUrl}?error=${encodeURIComponent(friendly)}`);
  }

  return c.redirect(`/settings/teams/${slug}`);
});
