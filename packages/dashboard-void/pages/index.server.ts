import { defineHandler, type InferProps } from "void";
import { getSession } from "void/auth";
import { getPendingInvitesForUser, getUserTeams } from "@/lib/authz";

export type Props = InferProps<typeof loader>;

/**
 * Index loader. Decides where to land a signed-in user:
 *   1. Not signed in → redirect to /login.
 *   2. No pending invites + the `wf_workspace` cookie resolved to a real
 *      team/project → jump there.
 *   3. Otherwise render the team picker (with any pending invites).
 *
 * Pending invites take priority over the redirect-to-default path: a user
 * with active teams *and* a fresh invite needs the picker to accept it.
 *
 * The "where was I last" lookup runs in `middleware/01.context.ts` from the
 * cookie — `c.var.shared.selectedTeam` / `selectedProject` are already
 * membership-checked by the time this loader runs.
 */
export const loader = defineHandler(async (c) => {
  const session = getSession();
  if (!session) return c.redirect("/login");

  const [pendingInvites, teams] = await Promise.all([
    getPendingInvitesForUser(session.user.id),
    getUserTeams(session.user.id),
  ]);

  if (pendingInvites.length === 0) {
    const shared = c.get("shared");
    const team = shared.selectedTeam;
    const project = shared.selectedProject;
    if (team && project) {
      return c.redirect(`/t/${team.slug}/p/${project.slug}`);
    }
    if (team) {
      return c.redirect(`/t/${team.slug}`);
    }
  }

  return { teams, pendingInvites };
});
