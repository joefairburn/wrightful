import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { and, db, desc, eq, gt } from "void/db";
import { memberships, teamInvites } from "@schema";
import { getUsersByIds } from "@/lib/auth-users";
import { resolveTeamBySlug, type TeamRole } from "@/lib/authz";
import { readField } from "@/lib/form";
import { requireOwnerScope } from "@/lib/settings-scope";

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
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  const team = await resolveTeamBySlug(user.id, teamSlug);
  if (!team) throw new Response("Not Found", { status: 404 });

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
};
