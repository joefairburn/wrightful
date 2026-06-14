import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { and, db, desc, eq, gt } from "void/db";
import { memberships, teamInvites } from "@schema";
import { getUsersByIds } from "@/lib/auth-users";
import { type TeamRole } from "@/lib/authz";
import {
  notLastOwner,
  removeMemberGuarded,
  roleSchema,
  setMemberRole,
} from "@/lib/members-repo";
import { ASSIGNABLE_ROLES, ROLE_DESCRIPTIONS } from "@/lib/roles";
import { readField } from "@/lib/form";
import {
  redirectWithParam,
  requireMemberScope,
  requireRoleScope,
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
  const { team } = await requireRoleScope(c, "viewSettings");
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
    // The role ladder + copy live in `roles.ts`; surface them so the page's
    // role selectors and the validator stay one source of truth.
    assignableRoles: ASSIGNABLE_ROLES,
    roleDescriptions: ROLE_DESCRIPTIONS,
  };
});

export const actions = {
  /** Delete a pending invite by id. Requires `manageMembers`. */
  revokeInvite: defineHandler(async (c) => {
    const { team, here } = await requireRoleScope(c, "manageMembers", hereFor);
    const redirectTo = here ?? hereFor(team);

    const form = await c.req.formData();
    const inviteId = readField(form, "inviteId").trim();
    if (!inviteId) return c.redirect(redirectTo);
    await db
      .delete(teamInvites)
      .where(
        and(eq(teamInvites.id, inviteId), eq(teamInvites.teamId, team.id)),
      );
    return c.redirect(redirectTo);
  }),

  /**
   * Change a member's role (owner / member / viewer). Requires `manageMembers`.
   * The target role is Zod-validated against the shared role list.
   *
   * The last-owner invariant is enforced by `setMemberRole`'s owner-count
   * subquery in the UPDATE WHERE (not a check-then-write) — demoting the team's
   * sole owner matches 0 rows and surfaces the inline error, so two concurrent
   * demotions can never both land and strand the team ownerless.
   */
  updateMemberRole: defineHandler(async (c) => {
    const { team, here } = await requireRoleScope(c, "manageMembers", hereFor);
    const actor = requireAuth(c);
    const redirectTo = here ?? hereFor(team);

    const form = await c.req.formData();
    const userId = readField(form, "userId").trim();
    const parsed = roleSchema.safeParse(readField(form, "role").trim());
    if (!userId || !parsed.success) {
      return redirectWithParam(
        c,
        redirectTo,
        "membersError",
        "Pick a valid role for that member.",
      );
    }

    // No special-casing of self-demotion: an owner demoting themselves is fine
    // as long as another owner remains — exactly what the last-owner guard
    // already enforces. If they're the last owner the guard blocks it.
    const result = await setMemberRole(team.id, userId, parsed.data);
    if (!result.ok && result.reason === "lastOwner") {
      return redirectWithParam(
        c,
        redirectTo,
        "membersError",
        actor.id === userId
          ? "You're the last owner — promote someone else before changing your role."
          : "That's the team's last owner — promote someone else first.",
      );
    }
    return c.redirect(redirectTo);
  }),

  /**
   * Remove a member from the team. Requires `manageMembers`. Self-removal goes
   * through `leaveTeam` instead (which carries its own last-owner guard).
   *
   * The removal is itself last-owner-safe (`removeMemberGuarded`: owner-count
   * subquery in the DELETE WHERE), so even though self-removal is blocked here,
   * removing another *owner* can never strand the team ownerless — removing the
   * sole owner matches 0 rows and surfaces the inline error.
   */
  removeMember: defineHandler(async (c) => {
    const { team, here } = await requireRoleScope(c, "manageMembers", hereFor);
    const actor = requireAuth(c);
    const redirectTo = here ?? hereFor(team);

    const form = await c.req.formData();
    const userId = readField(form, "userId").trim();
    if (!userId) return c.redirect(redirectTo);
    if (userId === actor.id) {
      return redirectWithParam(
        c,
        redirectTo,
        "membersError",
        "You can't remove yourself — use Leave team instead.",
      );
    }
    const result = await removeMemberGuarded(team.id, userId);
    if (!result.ok && result.reason === "lastOwner") {
      return redirectWithParam(
        c,
        redirectTo,
        "membersError",
        "That's the team's last owner — promote someone else first.",
      );
    }
    return c.redirect(redirectTo);
  }),

  /**
   * Leave the team (any role, viewers included). The last owner can't leave —
   * a team without an owner has no one who can manage members, keys, or delete
   * it; they must delete the team (or promote someone first).
   *
   * The last-owner guard lives INSIDE the DELETE (the `notLastOwner` owner-count
   * subquery in the WHERE, verified via `.returning()`), not as a separate
   * SELECT: a check-then-delete pair would let the last two owners leave
   * concurrently — both reads see 2 owners, both deletes land, and the team is
   * permanently ownerless. With the guard in the statement, D1 serializes the
   * writes and the second delete matches 0 rows. Same atomic-SQL pattern as
   * `completeRun`'s status merge — and the same predicate the member-role and
   * member-remove actions reuse via `members-repo`.
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
          notLastOwner(team.id),
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
