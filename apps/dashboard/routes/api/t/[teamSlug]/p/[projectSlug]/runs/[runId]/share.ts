import type { Context } from "hono";
import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { and, db, eq, isNull } from "void/db";
import { env } from "void/env";
import { ulid } from "ulid";
import { runShares, runs } from "@schema";
import { runByIdWhere, tenantScopeForUserBySlugs } from "@/lib/scope";
import {
  shareRunPath,
  shareTokenHash,
  signShareToken,
} from "@/lib/share-tokens";

/**
 * Mint / revoke a public read-only share link for a run.
 *
 *   POST   → create a signed `/share/run/:token` link (member access).
 *   DELETE → revoke every active link for the run.
 *
 * Session-authed (NOT an ingest route — `/api/t/*` is gated by the dashboard
 * cookie, not a Bearer key). The token itself proves authenticity statelessly;
 * the `runShares` row exists so the link can be revoked before expiry.
 */

async function scopeFor(c: Context) {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  const projectSlug = c.req.param("projectSlug");
  const runId = c.req.param("runId");
  if (!teamSlug || !projectSlug || !runId) {
    throw new Response("Not Found", { status: 404 });
  }
  const scope = await tenantScopeForUserBySlugs(user.id, teamSlug, projectSlug);
  if (!scope) throw new Response("Not Found", { status: 404 });
  return { user, scope, runId };
}

export const POST = defineHandler(async (c) => {
  const { user, scope, runId } = await scopeFor(c);

  const runRows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(runByIdWhere(scope, runId))
    .limit(1);
  if (!runRows[0]) throw new Response("Not Found", { status: 404 });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const { token, expiresAt } = await signShareToken({
    runId,
    projectId: scope.projectId,
    teamId: scope.teamId,
  });
  await db.insert(runShares).values({
    id: ulid(),
    runId,
    projectId: scope.projectId,
    teamId: scope.teamId,
    tokenHash: await shareTokenHash(token),
    createdBy: user.id,
    createdAt: nowSeconds,
    expiresAt,
    revokedAt: null,
  });

  return c.json(
    { url: `${env.WRIGHTFUL_PUBLIC_URL}${shareRunPath(token)}`, expiresAt },
    201,
  );
});

export const DELETE = defineHandler(async (c) => {
  const { scope, runId } = await scopeFor(c);
  const nowSeconds = Math.floor(Date.now() / 1000);
  await db
    .update(runShares)
    .set({ revokedAt: nowSeconds })
    .where(
      and(
        eq(runShares.projectId, scope.projectId),
        eq(runShares.runId, runId),
        isNull(runShares.revokedAt),
      ),
    );
  return c.json({ ok: true });
});
