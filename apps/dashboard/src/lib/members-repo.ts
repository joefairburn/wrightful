import { z } from "zod";
import { and, db, eq, ne, or, sql } from "void/db";
import { memberships, type MembershipRole } from "@schema";
import { ASSIGNABLE_ROLES } from "@/lib/roles";

/**
 * Membership mutations (roadmap 3.1: role editing + removal) and the one
 * invariant they all share: **a team must never be left with zero owners**.
 *
 * The guard is enforced INSIDE the write (an owner-count subquery in the WHERE),
 * never as a check-then-write — the exact pattern `leaveTeam` uses. A
 * check-then-write pair would let two concurrent demotions/removals both read
 * "2 owners" and both land, stranding the team ownerless. With the predicate in
 * the statement D1 serializes the writes and the second one matches 0 rows;
 * the caller reads `.returning()` / the affected-row count to detect that and
 * surface the inline error. Same atomic-SQL family as `completeRun`'s merge.
 *
 * The role validator + the guard live here (a tiny repo seam) so they're shared
 * by the members page action and the invite-mint API, and so the guard's WHERE
 * shape is unit-testable against the `void/db` stub without a real D1.
 */

/**
 * Zod validator for a target membership role, narrowing an untrusted string to
 * a {@link MembershipRole}. The source list is {@link ASSIGNABLE_ROLES} (an
 * `as const` tuple) so the validator, the UI selector, and the invite schema
 * can't drift — and `z.enum` accepts the tuple directly, no cast.
 */
export const roleSchema = z.enum(ASSIGNABLE_ROLES);

/**
 * SQL predicate that is true unless flipping THIS row would strand the team
 * ownerless — i.e. the row is not the team's last owner. Reused verbatim by the
 * role-demote UPDATE and the member-remove DELETE.
 *
 * Reads as: the row is *not* an owner (demoting/removing a non-owner is always
 * safe) **OR** more than one owner exists on the team. When the acting row is
 * the sole owner, both arms are false and the write matches 0 rows.
 *
 * `teamId` is interpolated as a bound param (caller passes the
 * authz-resolved id); the literal `'owner'` is the stored role string. The
 * return type is whatever `or(...)` produces (drizzle's `SQL` expression) —
 * fed straight into `.where(and(..., notLastOwner(teamId)))`.
 */
export function notLastOwner(teamId: string) {
  return or(
    ne(memberships.role, "owner"),
    sql`(select count(*) from ${memberships} where ${memberships.teamId} = ${teamId} and ${memberships.role} = 'owner') > 1`,
  );
}

/** Outcome of a last-owner-guarded write. */
export type GuardedWriteResult =
  | { ok: true }
  | { ok: false; reason: "noop" }
  | { ok: false; reason: "lastOwner" };

/**
 * Set `targetUserId`'s role on `teamId`, guarded so the last owner can't be
 * demoted away from `owner`. The owner-count subquery rides in the WHERE, so
 * the demote-the-last-owner race is impossible (see module doc).
 *
 * `.returning()` distinguishes the two zero-row causes the UI must tell apart:
 *  - the membership row doesn't exist (already gone) → `noop`;
 *  - the row exists but the guard blocked it (last owner being demoted) →
 *    `lastOwner`.
 * We can't read that apart from the affected-row count alone, so we re-check
 * "does the row still exist as owner?" only on the zero-row path.
 */
export async function setMemberRole(
  teamId: string,
  targetUserId: string,
  role: MembershipRole,
): Promise<GuardedWriteResult> {
  // Demoting away from owner is the only case the guard can block. Promoting TO
  // owner, or any change that keeps the row an owner, is unconditionally safe —
  // but applying the guard uniformly is harmless (it only ever subtracts the
  // last-owner-demotion case) and keeps one code path. The guard's first arm
  // (`role != 'owner'`) already lets a non-owner row through.
  const updated = await db
    .update(memberships)
    .set({ role })
    .where(
      and(
        eq(memberships.teamId, teamId),
        eq(memberships.userId, targetUserId),
        // Only guard when the new role is NOT owner — promoting/keeping owner
        // never reduces the owner count. When demoting, require not-last-owner.
        role === "owner" ? undefined : notLastOwner(teamId),
      ),
    )
    .returning({ id: memberships.id });

  if (updated.length > 0) return { ok: true };

  // Zero rows: either the row vanished, or the guard blocked a last-owner
  // demotion. Disambiguate with a cheap existence read.
  const stillThere = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(eq(memberships.teamId, teamId), eq(memberships.userId, targetUserId)),
    )
    .limit(1);
  if (stillThere.length === 0) return { ok: false, reason: "noop" };
  return { ok: false, reason: "lastOwner" };
}

/**
 * Remove `targetUserId` from `teamId`, guarded so the team's last owner can't
 * be removed. Same owner-count-subquery-in-the-WHERE shape as
 * {@link setMemberRole}; `.returning()` separates "already gone" from
 * "blocked by the guard".
 */
export async function removeMemberGuarded(
  teamId: string,
  targetUserId: string,
): Promise<GuardedWriteResult> {
  const deleted = await db
    .delete(memberships)
    .where(
      and(
        eq(memberships.teamId, teamId),
        eq(memberships.userId, targetUserId),
        notLastOwner(teamId),
      ),
    )
    .returning({ id: memberships.id });

  if (deleted.length > 0) return { ok: true };

  const stillThere = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(eq(memberships.teamId, teamId), eq(memberships.userId, targetUserId)),
    )
    .limit(1);
  if (stillThere.length === 0) return { ok: false, reason: "noop" };
  return { ok: false, reason: "lastOwner" };
}

/** Outcome of the self-leave guarded delete — narrower than {@link GuardedWriteResult}. */
export type LeaveTeamResult = { ok: true } | { ok: false; reason: "lastOwner" };

/**
 * Remove the ACTOR'S OWN membership from `teamId`, guarded so the team's last
 * owner can't leave — the same `notLastOwner` owner-count-subquery-in-the-WHERE
 * shape as {@link removeMemberGuarded}, so the guarded-DELETE plumbing lives in
 * one place (this repo) and rides its test surface rather than being open-coded
 * in the members page action.
 *
 * Unlike {@link removeMemberGuarded} — which targets an arbitrary user whose
 * row may have vanished concurrently and so must disambiguate `noop` vs
 * `lastOwner` — this is only reachable after a member-scope check has already
 * proven the actor's own membership is live (`requireMemberScope` →
 * `resolveTeamBySlug` inner-joins `memberships`). A zero-row result can
 * therefore ONLY mean the guard blocked a last-owner leave, so the result is
 * narrower (no `noop`) and there is no vanished-vs-blocked re-check.
 */
export async function leaveTeamGuarded(
  teamId: string,
  userId: string,
): Promise<LeaveTeamResult> {
  const deleted = await db
    .delete(memberships)
    .where(
      and(
        eq(memberships.teamId, teamId),
        eq(memberships.userId, userId),
        notLastOwner(teamId),
      ),
    )
    .returning({ id: memberships.id });

  return deleted.length > 0 ? { ok: true } : { ok: false, reason: "lastOwner" };
}
