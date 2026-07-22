import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { db, eq } from "void/db";
import { env } from "void/env";
import { ulid } from "ulid";
import { githubInstallations } from "@schema";
import { getUserGithubAccessToken } from "@/lib/auth-users";
import { resolveTeamBySlug } from "@/lib/authz";
import { githubAppEnabled } from "@/lib/config";
import {
  fetchInstallationAccountLogin,
  verifyUserAdministersInstallation,
} from "@/lib/github-app";
import { isUniqueViolation } from "@/lib/db-batch";
import { gateTeamScope } from "@/lib/settings-scope";
// Import the general settings page's flash declaration so the `githubError` slot
// name is compile-checked against what its loader reads (this route is the only writer).
import { GENERAL_FLASH } from "../../../pages/settings/teams/[teamSlug]/general.server";

/**
 * GET /api/github/setup — the GitHub App "Setup URL" callback.
 *
 * After a team owner installs the App (via the link on the team settings page,
 * which carries `state=<teamSlug>`), GitHub redirects here with `installation_id`
 * + `state`. We resolve the team from `state`, require the signed-in user be its
 * owner, prove the user administers `installation_id` on GitHub's side, look up
 * the installation's account login (the repo-owner resolution key), and persist
 * the link. Row creation lives here — not the webhook — because only this flow
 * knows which Wrightful team the installation belongs to.
 *
 * Security (H1): `state` and `installation_id` are both attacker-suppliable, so
 * the owner gate proves nothing about the installation — a signed-in owner of a
 * throwaway team could otherwise claim any unlinked installation id and drive
 * that org's repos via check runs. `verifyUserAdministersInstallation` (below)
 * is the barrier: it asks GitHub, with the user's own OAuth token, whether the
 * id is one they may administer. Do not remove it.
 */
export const GET = defineHandler(async (c) => {
  const user = requireAuth(c);
  if (!githubAppEnabled(env)) throw new Response("Not Found", { status: 404 });

  const url = new URL(c.req.url);
  const installationIdRaw = url.searchParams.get("installation_id");
  const teamSlug = url.searchParams.get("state");
  const installationId = Number(installationIdRaw);
  if (!installationIdRaw || !Number.isInteger(installationId) || !teamSlug) {
    throw new Response("Invalid GitHub setup callback", { status: 400 });
  }

  // Owner-only, 404 (not 403) on a missing team / non-owner — no existence
  // leak. Linking the GitHub App mutates team config, so gate on `writeConfig`
  // (owner-only in the capability matrix).
  const team = gateTeamScope(
    await resolveTeamBySlug(user.id, teamSlug),
    "writeConfig",
  );
  if (!team) throw new Response("Not Found", { status: 404 });
  const here = `/settings/teams/${team.slug}/general`;

  // H1: prove the user administers this installation on GitHub before linking
  // (see JSDoc above). Uses the user's stored OAuth token; fail leak-safe (a
  // flash, never a 500) on every non-authorized branch.
  const githubToken = await getUserGithubAccessToken(user.id);
  if (!githubToken) {
    // No linked GitHub account (or GitHub OAuth off) → can't verify ownership,
    // so don't link; point the user at sign-in-with-GitHub, which persists the token.
    return GENERAL_FLASH.fail(
      c,
      here,
      "githubError",
      "Connect your GitHub account (sign in with GitHub) before linking an installation.",
    );
  }
  const ownership = await verifyUserAdministersInstallation(
    githubToken,
    installationId,
  );
  if (ownership === "denied") {
    return GENERAL_FLASH.fail(
      c,
      here,
      "githubError",
      "You don't have admin access to this GitHub installation, so it can't be linked to your team.",
    );
  }
  if (ownership === "error") {
    return GENERAL_FLASH.fail(
      c,
      here,
      "githubError",
      "Could not verify your access to this GitHub installation. Please try again.",
    );
  }

  // `nowSeconds` is reused below for the githubInstallations row timestamps; the
  // App creds + JWT clock for the lookup now live inside the github-app seam.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const accountLogin = await fetchInstallationAccountLogin(installationId);
  if (!accountLogin) {
    return GENERAL_FLASH.fail(
      c,
      here,
      "githubError",
      "Could not read the GitHub installation. Please try again.",
    );
  }

  // A GitHub installation links to exactly ONE team. `installation_id` is an
  // enumerable, attacker-suppliable integer, so a blind upsert keyed on it would
  // let any signed-in team owner REPOINT another team's connected installation
  // to themselves — and then abuse its token (via `postGithubRunSurfaces`) to
  // post merge-gating check runs on that org's repos. Look up the current link
  // first and refuse to steal one that belongs to a different team; re-running
  // setup for the SAME team stays idempotent.
  const existing = await db
    .select({ teamId: githubInstallations.teamId })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);
  if (existing[0] && existing[0].teamId !== team.id) {
    return GENERAL_FLASH.fail(
      c,
      here,
      "githubError",
      "This GitHub installation is already connected to another team. Disconnect it there first.",
    );
  }

  if (existing[0]) {
    // Same team re-running setup — refresh the resolved account login + clock.
    await db
      .update(githubInstallations)
      .set({ accountLogin, updatedAt: nowSeconds })
      .where(eq(githubInstallations.installationId, installationId));
  } else {
    try {
      await db.insert(githubInstallations).values({
        id: ulid(),
        teamId: team.id,
        installationId,
        accountLogin,
        createdAt: nowSeconds,
        updatedAt: nowSeconds,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // The accountLogin unique index: a different installation already linked
        // this org to another team (or a concurrent setup raced this insert).
        return GENERAL_FLASH.fail(
          c,
          here,
          "githubError",
          `The GitHub organization "${accountLogin}" is already connected to another team.`,
        );
      }
      throw err;
    }
  }

  return c.redirect(here);
});
