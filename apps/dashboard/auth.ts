import { defineAuth, type VoidAuthConfigContext } from "void/auth";
import { ulid } from "ulid";

// Derive hook signatures from void/auth's defaults shape so we don't have
// to add a direct dependency on `better-auth` (it's transitive via `void`).
// Better Auth's `create.after` and `update.after` share the same
// `(account, context) => Promise<void>` shape — using `create` covers both.
type AccountAfter = NonNullable<
  NonNullable<
    NonNullable<
      NonNullable<VoidAuthConfigContext["defaults"]["databaseHooks"]>["account"]
    >["create"]
  >["after"]
>;
type AccountRow = Parameters<AccountAfter>[0];
type AccountContext = Parameters<AccountAfter>[1];

/**
 * Customize the void-managed Better Auth instance.
 *
 * Void owns the mount path (`/api/auth/*`), the D1 adapter, the
 * `BETTER_AUTH_SECRET` lifecycle, and the email + GitHub provider wiring
 * (declared in `void.json#auth.providers`, credentials read from
 * `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET`).
 *
 * We extend that surface with:
 *   - ULID ids for auth rows (matches the rest of the schema).
 *   - `requireEmailVerification: false` until an email sender is wired up.
 *   - A post-create hook on the `account` row that mirrors the GitHub login
 *     into `userGithubAccounts` so directed-by-github-handle invites can
 *     resolve. Better Auth only stores the numeric `accountId`; we need the
 *     human-readable login as well.
 *
 * NOTE: dynamic imports are used inside the hook so `void prepare` can load
 * this file at config time (when the runtime db/schema aren't bound yet).
 */
async function captureGithubLogin(
  userId: string,
  accessToken: string | null | undefined,
): Promise<void> {
  if (!accessToken) return;
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "wrightful-dashboard",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) return;
  const body = (await res.json()) as { login?: unknown };
  if (typeof body.login !== "string" || body.login === "") return;
  const login = body.login.toLowerCase();
  const now = Date.now();
  const [{ db }, { userGithubAccounts }] = await Promise.all([
    import("void/db"),
    import("@schema"),
  ]);
  await db
    .insert(userGithubAccounts)
    .values({ userId, githubLogin: login, updatedAt: now })
    .onConflictDoUpdate({
      target: userGithubAccounts.userId,
      set: { githubLogin: login, updatedAt: now },
    });
}

// Read GitHub OAuth creds via Node's `process.env` so this works both at
// `void prepare` (config-evaluation time, before void's typed `env` proxy is
// bound) and at request time. Treat them as optional — only register the
// provider when BOTH are set, so a clean checkout works without forcing
// the user to set up a GitHub OAuth app first.
const githubClientId = process.env.AUTH_GITHUB_CLIENT_ID;
const githubClientSecret = process.env.AUTH_GITHUB_CLIENT_SECRET;
const githubProviderEnabled = Boolean(githubClientId && githubClientSecret);

// Open signup is off by default — self-hosters add users via invites until
// email verification is wired up. Read via `process.env` for the same
// config-time-evaluation reason as the GitHub creds above.
const openSignupAllowed = /^(true|1)$/i.test(
  process.env.ALLOW_OPEN_SIGNUP ?? "",
);

export default defineAuth(({ defaults }) => ({
  ...defaults,
  advanced: {
    ...defaults.advanced,
    database: { ...defaults.advanced?.database, generateId: () => ulid() },
  },
  emailAndPassword: {
    ...defaults.emailAndPassword,
    enabled: true,
    requireEmailVerification: false,
    disableSignUp: !openSignupAllowed,
  },
  socialProviders: {
    ...defaults.socialProviders,
    ...(githubProviderEnabled
      ? {
          github: {
            clientId: githubClientId as string,
            clientSecret: githubClientSecret as string,
            // Only `user:email` (required for the email claim). The previous
            // `read:org` scope existed for GitHub-org auto-join team
            // suggestions, which were replaced by directed invites
            // (docs/worklog/2026-05-05-directed-invites-replace-org-link.md) —
            // nothing reads org membership anymore, so requesting it just
            // inflates the OAuth consent screen.
            scope: ["user:email"],
          },
        }
      : {}),
  },
  databaseHooks: {
    ...defaults.databaseHooks,
    account: {
      ...defaults.databaseHooks?.account,
      create: {
        ...defaults.databaseHooks?.account?.create,
        // Chain to any default `create.after` first so void's bookkeeping
        // isn't disturbed, then mirror the GitHub login into our own table.
        after: async (account: AccountRow, context: AccountContext) => {
          await defaults.databaseHooks?.account?.create?.after?.(
            account,
            context,
          );
          if (account.providerId !== "github") return;
          try {
            await captureGithubLogin(account.userId, account.accessToken);
          } catch {
            // Best effort.
          }
        },
      },
      update: {
        ...defaults.databaseHooks?.account?.update,
        after: async (account: AccountRow, context: AccountContext) => {
          await defaults.databaseHooks?.account?.update?.after?.(
            account,
            context,
          );
          if (account.providerId !== "github") return;
          try {
            await captureGithubLogin(account.userId, account.accessToken);
          } catch {
            // Best effort.
          }
        },
      },
    },
  },
}));
