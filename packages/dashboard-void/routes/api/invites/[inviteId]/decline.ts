import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { and, db, eq, or } from "void/db";
import { teamInvites, userGithubAccounts } from "@schema";

/**
 * POST /api/invites/:inviteId/decline
 *
 * Soft-decline by deleting the invite. The caller must be the invite's
 * intended recipient — matched by email (from void's user table) or by the
 * GitHub login captured at OAuth sign-in. Without this binding any signed-in
 * user could enumerate invite ids and burn other users' invites.
 *
 * We don't keep a "declined" tombstone because directed invites are
 * re-issuable — an admin who wants the user back can just send a fresh one.
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);
  const inviteId = c.req.param("inviteId");
  if (!inviteId) return c.json({ error: "Not found" }, 404);

  const [userRow, ghRow] = await Promise.all([
    db.run({
      sql: `SELECT email FROM "user" WHERE id = ?1 LIMIT 1`,
      params: [user.id],
    } as never),
    db
      .select({ githubLogin: userGithubAccounts.githubLogin })
      .from(userGithubAccounts)
      .where(eq(userGithubAccounts.userId, user.id))
      .limit(1),
  ]);
  const email =
    (
      userRow.results?.[0] as { email?: string } | undefined
    )?.email?.toLowerCase() ?? null;
  const githubLogin = ghRow[0]?.githubLogin ?? null;

  const matchConds: ReturnType<typeof eq>[] = [];
  if (email) matchConds.push(eq(teamInvites.email, email));
  if (githubLogin) matchConds.push(eq(teamInvites.githubLogin, githubLogin));
  if (matchConds.length === 0) {
    return c.json({ error: "Invite not addressed to this account" }, 403);
  }

  const result = await db
    .delete(teamInvites)
    .where(and(eq(teamInvites.id, inviteId), or(...matchConds)));
  // Drizzle/D1 returns a meta object; treat 0 affected rows as a 404 so a
  // caller probing for invite ids can't distinguish "exists but not yours"
  // from "doesn't exist".
  const meta = (result as { meta?: { changes?: number } }).meta;
  if (meta && typeof meta.changes === "number" && meta.changes === 0) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ ok: true });
});
