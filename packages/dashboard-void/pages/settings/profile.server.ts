import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { db, eq, sql } from "void/db";
import { userGithubAccounts } from "@schema";

export type Props = InferProps<typeof loader>;

/**
 * Settings → Profile loader. Returns the signed-in user's identity, whether
 * they have a password (some users sign in only via OAuth), and any GitHub
 * link with its login + connected-at timestamp.
 *
 * Reads the void-managed `account` table via raw SQL because it's not in our
 * Drizzle schema (see db/schema.ts for the same pattern with `"user"`).
 */
export const loader = defineHandler(async (c) => {
  const sessionUser = requireAuth(c);

  const [accountsRaw, githubRow] = await Promise.all([
    db.run(sql`
      SELECT providerId, createdAt
        FROM account
        WHERE userId = ${sessionUser.id}
    `),
    db
      .select({
        githubLogin: userGithubAccounts.githubLogin,
        updatedAt: userGithubAccounts.updatedAt,
      })
      .from(userGithubAccounts)
      .where(eq(userGithubAccounts.userId, sessionUser.id))
      .limit(1),
  ]);

  const accounts = (accountsRaw.results ?? []) as Array<{
    providerId: string;
    createdAt: number | string | null;
  }>;

  const hasPassword = accounts.some((a) => a.providerId === "credential");
  const githubAccountRow = accounts.find((a) => a.providerId === "github");

  let githubAccount: { login: string; connectedAt: number | null } | null =
    null;
  if (githubAccountRow && githubRow[0]) {
    const ts = githubAccountRow.createdAt;
    let connectedAt: number | null = null;
    if (typeof ts === "number") connectedAt = ts;
    else if (typeof ts === "string") {
      const parsed = Date.parse(ts);
      connectedAt = Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
    }
    githubAccount = {
      login: githubRow[0].githubLogin,
      connectedAt,
    };
  } else if (githubAccountRow) {
    githubAccount = { login: "", connectedAt: null };
  }

  const githubEnabled = Boolean(
    process.env.AUTH_GITHUB_CLIENT_ID && process.env.AUTH_GITHUB_CLIENT_SECRET,
  );

  return {
    user: {
      id: sessionUser.id,
      name: sessionUser.name,
      email: sessionUser.email,
      image: sessionUser.image ?? null,
    },
    hasPassword,
    githubAccount,
    githubEnabled,
  };
});
