import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { and, db, desc, eq, gt, ne, or, sql } from "void/db";
import { memberships, teamInvites } from "@schema";
import { getUsersByIds } from "@/lib/auth-users";
import { type TeamRole } from "@/lib/authz";
import { readField } from "@/lib/form";
import {
  redirectWithParam,
  requireMemberScope,
  requireOwnerScope,
} from "@/lib/settings-scope";

export type Props = InferProps<typeof loader>;

const hereFor = (team: { slug: string }) =>
  `/settings/teams/${team.slug}/members`;

interface MemberRow {
  userId: string;
  role: TeamRole;
  email: string;
  name: string;
  image: string | null;
}

/**
 * Settings → Team → Members. Lists existing members and pending invites.
 *
 * Invite creation happens via `POST /api/teams/:teamSlug/invites` from the
 * client (so the reveal modal can stay open without a full page reload).
 * The remaining server action handles the slow-path revoke (no-JS).
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireMemberScope(c);
  const user = requireAuth(c);
  const membersError = new URL(c.req.url).searchParams.get("membersError");

  const [membershipRows, inviteRows] = await Promise.all([
    db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.teamId, team.id)),
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

  // Hydrate member profiles from the void-owned `user` table via the
  // auth-users seam (the only owner of that raw read), keyed by user id.
  // Drop memberships without a matching `user` row to preserve the original
  // INNER JOIN semantics (a missing user row should be impossible anyway).
  const profiles = await getUsersByIds(membershipRows.map((m) => m.userId));
  const members: MemberRow[] = membershipRows.flatMap((m) => {
    const profile = profiles.get(m.userId);
    if (!profile) return [];
    return [
      {
        userId: m.userId,
        role: m.role,
        email: profile.email,
        name: profile.name,
        image: profile.image,
      },
    ];
  });

  return {
    team,
    members,
    invites: inviteRows,
    currentUserId: user.id,
    membersError,
  };
});

export const actions = {
  /** Delete a pending invite by id. */
  revokeInvite: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c, hereFor);

    const form = await c.req.formData();
    const inviteId = readField(form, "inviteId").trim();
    if (!inviteId) return c.redirect(here);
    await db
      .delete(teamInvites)
      .where(
        and(eq(teamInvites.id, inviteId), eq(teamInvites.teamId, team.id)),
      );
    return c.redirect(here);
  }),

  /**
   * Remove a member from the team. Owner-only. Self-removal goes through
   * `leaveTeam` instead (which carries the last-owner guard) — blocking it
   * here also means this action can never strand the team ownerless: the
   * acting owner always survives the removal.
   */
  removeMember: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c, hereFor);
    const actor = requireAuth(c);

    const form = await c.req.formData();
    const userId = readField(form, "userId").trim();
    if (!userId) return c.redirect(here);
    if (userId === actor.id) {
      return redirectWithParam(
        c,
        here,
        "membersError",
        "You can't remove yourself — use Leave team instead.",
      );
    }
    await db
      .delete(memberships)
      .where(
        and(eq(memberships.teamId, team.id), eq(memberships.userId, userId)),
      );
    return c.redirect(here);
  }),

  /**
   * Leave the team (any role). The last owner can't leave — a team without an
   * owner has no one who can manage members, keys, or delete it; they must
   * delete the team (or promote someone first, when role changes exist).
   *
   * The last-owner guard lives INSIDE the DELETE (an owner-count subquery in
   * the WHERE, verified via `.returning()`), not as a separate SELECT: a
   * check-then-delete pair would let the last two owners leave concurrently —
   * both reads see 2 owners, both deletes land, and the team is permanently
   * ownerless. With the guard in the statement, D1 serializes the writes and
   * the second delete matches 0 rows. Same atomic-SQL pattern as
   * `completeRun`'s status merge.
   */
  leaveTeam: defineHandler(async (c) => {
    const { team, here } = await requireMemberScope(c, hereFor);
    const actor = requireAuth(c);

    const deleted = await db
      .delete(memberships)
      .where(
        and(
          eq(memberships.teamId, team.id),
          eq(memberships.userId, actor.id),
          or(
            ne(memberships.role, "owner"),
            sql`(select count(*) from ${memberships} where ${memberships.teamId} = ${team.id} and ${memberships.role} = 'owner') > 1`,
          ),
        ),
      )
      .returning({ id: memberships.id });

    if (deleted.length === 0) {
      // The only guard that can match 0 rows for a live membership is the
      // owner-count subquery — the actor is the last owner.
      return redirectWithParam(
        c,
        here ?? "/",
        "membersError",
        "You're the last owner — delete the team instead.",
      );
    }
    return c.redirect("/");
  }),
};
