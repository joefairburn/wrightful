import { defineHandler, type InferProps } from "void";
import { getSession } from "void/auth";
import { getPendingInvitesForUser, getUserTeams } from "@/lib/authz";
import { resolveDefaultLanding } from "@/lib/user-state";

export type Props = InferProps<typeof loader>;

/**
 * Index loader. Decides where to land a signed-in user:
 *   1. Not signed in → redirect to /login.
 *   2. No pending invites + has a resolvable default landing → jump there.
 *   3. Otherwise render the team picker (with any pending invites).
 *
 * Pending invites take priority over the redirect-to-default path: a user
 * with active teams *and* a fresh invite needs the picker to accept it.
 */
export const loader = defineHandler(async (c) => {
  const session = getSession();
  if (!session) return c.redirect("/login");

  const [pendingInvites, teams] = await Promise.all([
    getPendingInvitesForUser(session.user.id),
    getUserTeams(session.user.id),
  ]);

  if (pendingInvites.length === 0) {
    const target = await resolveDefaultLanding(session.user.id);
    if (target) {
      const path =
        target.kind === "project"
          ? `/t/${target.teamSlug}/p/${target.projectSlug}`
          : `/t/${target.teamSlug}`;
      return c.redirect(path);
    }
  }

  return { teams, pendingInvites };
});
