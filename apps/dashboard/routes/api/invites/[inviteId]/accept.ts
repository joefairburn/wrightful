import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { and, db, eq, gt, or, sql } from "void/db";
import { ulid } from "ulid";
import { memberships, teamInvites, userGithubAccounts } from "@schema";
import { runBatch } from "@/lib/db-batch";

/**
 * POST /api/invites/:inviteId/accept
 *
 * Resolve a directed invite (email or github login) addressed to the signed-in
 * user, create the membership row, and delete the invite. Same row counts as
 * a transaction via `db.batch` so we don't end up with a membership without
 * the invite being consumed (or vice versa).
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);
  const inviteId = c.req.param("inviteId");
  if (!inviteId) return c.json({ error: "Not found" }, 404);

  // Fetch the user's email (from void's user table via raw SQL) and
  // captured github login so we can match against the invite addressing.
  const [userRow, ghRow] = await Promise.all([
    db.run(sql`SELECT email FROM "user" WHERE id = ${user.id} LIMIT 1`),
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

  const now = Math.floor(Date.now() / 1000);
  const matchConds: ReturnType<typeof eq>[] = [];
  if (email) matchConds.push(eq(teamInvites.email, email));
  if (githubLogin) matchConds.push(eq(teamInvites.githubLogin, githubLogin));
  if (matchConds.length === 0) {
    return c.json({ error: "Invite not addressed to this account" }, 403);
  }

  const rows = await db
    .select({
      id: teamInvites.id,
      teamId: teamInvites.teamId,
      role: teamInvites.role,
    })
    .from(teamInvites)
    .where(
      and(
        eq(teamInvites.id, inviteId),
        gt(teamInvites.expiresAt, now),
        or(...matchConds),
      ),
    )
    .limit(1);
  const invite = rows[0];
  if (!invite) {
    return c.json({ error: "Invite not found or expired" }, 404);
  }

  // Idempotent on re-accept: a second invite to the same team (or a previous
  // acceptance via the page-level handler) leaves the user already a member.
  // Consume the invite without re-inserting to avoid a unique-constraint 500.
  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, user.id),
        eq(memberships.teamId, invite.teamId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db.delete(teamInvites).where(eq(teamInvites.id, invite.id));
    return c.json({ ok: true, teamId: invite.teamId });
  }

  await runBatch([
    db.insert(memberships).values({
      id: ulid(),
      userId: user.id,
      teamId: invite.teamId,
      role: invite.role,
      createdAt: now,
    }),
    db.delete(teamInvites).where(eq(teamInvites.id, invite.id)),
  ]);

  return c.json({ ok: true, teamId: invite.teamId });
});
