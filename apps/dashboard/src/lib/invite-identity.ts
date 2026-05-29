import { db, eq, sql } from "void/db";
import { userGithubAccounts } from "@schema";

export interface InviteIdentity {
  email: string | null;
  githubLogin: string | null;
}

/**
 * A "directed" invite is addressed to a specific person — either an email
 * address or a GitHub login captured at OAuth sign-in. Token-link invites
 * (no identifier set) remain redeemable by anyone with the token.
 */
export function inviteIsDirected(invite: InviteIdentity): boolean {
  return Boolean(invite.email) || Boolean(invite.githubLogin);
}

/**
 * Confirm the caller's identity matches the invite's email or GitHub login.
 *
 * Used by every redemption path (the picker's accept button AND the token
 * share-link route) so a leaked token can't be used to sneak around the
 * directed-invite gate. Pre-existing token-link invites without a directed
 * identifier short-circuit via `inviteIsDirected` before this is called.
 *
 * Reads `user.email` from the void-managed `user` table via raw SQL — it
 * isn't declared in our Drizzle schema (see db/schema.ts header).
 */
export async function inviteMatchesUser(
  invite: InviteIdentity,
  userId: string,
): Promise<boolean> {
  if (invite.email) {
    const userRow = await db.run(
      sql`select email from "user" where id = ${userId} limit 1`,
    );
    const email = (userRow.results?.[0] as { email?: string } | undefined)
      ?.email;
    if (email && email.toLowerCase() === invite.email) {
      return true;
    }
  }
  if (invite.githubLogin) {
    const rows = await db
      .select({ githubLogin: userGithubAccounts.githubLogin })
      .from(userGithubAccounts)
      .where(eq(userGithubAccounts.userId, userId))
      .limit(1);
    if (rows[0]?.githubLogin === invite.githubLogin) return true;
  }
  return false;
}
