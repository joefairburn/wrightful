import { defineAuth, type VoidAuthConfigContext } from "void/auth";
import { ulid } from "ulid";
import type { MirrorableAccount } from "@/lib/github-account-mirror";

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
 * Void owns the mount path (`/api/auth/*`), the D1 adapter, and the
 * `BETTER_AUTH_SECRET` lifecycle. `void.json#auth.providers` declares only
 * `["email"]` — GitHub is registered HERE, conditionally, only when both
 * `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` are set. (Declaring
 * `github` in `void.json` would make void hard-require those creds at startup
 * — `resolveSocialProviderCredentials` throws on empty creds — which breaks a
 * clean checkout that has no GitHub OAuth app. Keeping the gate in this file
 * matches the request-time `githubOAuthEnabled` predicate the login/signup
 * pages already use.)
 *
 * We extend that surface with:
 *   - ULID ids for auth rows (matches the rest of the schema).
 *   - `requireEmailVerification: false` until an email sender is wired up.
 *   - A post-create/update hook on the `account` row that mirrors the GitHub
 *     login into `userGithubAccounts` so directed-by-github-handle invites can
 *     resolve. Better Auth only stores the numeric `accountId`; we need the
 *     human-readable login as well. The capture-and-upsert (and its
 *     config-time-safe dynamic imports) lives in
 *     `@/lib/github-account-mirror`; both hooks delegate to
 *     `runGithubAccountMirror`, which owns the chain-default-then-guard
 *     ordering and logs (rather than swallows) capture failures.
 */

// GitHub OAuth creds + open-signup flag are read via Node's `process.env` so
// this works at `void prepare` (config-evaluation time, before void's typed
// `env` proxy is bound). The same decode rules — register the GitHub provider
// only when BOTH creds are set (so a clean checkout works without a GitHub
// OAuth app), and open signup off unless explicitly truthy — are owned for the
// request-time loaders by `@/lib/config` (`githubOAuthEnabled` /
// `openSignupAllowed`). They're inlined HERE, not imported, because `void
// prepare` evaluates this file in a bare Node context that can't resolve the
// `@/lib` alias for a static value import (the same reason the github mirror
// below is loaded via a deferred dynamic import). Keep the two in sync.
const githubClientId = process.env.AUTH_GITHUB_CLIENT_ID;
const githubClientSecret = process.env.AUTH_GITHUB_CLIENT_SECRET;
const openSignupAllowed = /^(true|1)$/i.test(
  process.env.ALLOW_OPEN_SIGNUP ?? "",
);
// Email verification turns on ONLY when an email sender is configured. Read
// from `process.env` (not `void/env`) for the same reason as the creds above:
// this file is evaluated at `void prepare` config time too, before void's typed
// `env` proxy is bound. Mirrors the optional-by-default contract in
// `src/lib/email.ts` — no `EMAIL_FROM` ⇒ no verification requirement, so a
// self-hoster who hasn't set up CES is unaffected (and the send hooks below are
// graceful no-ops via `sendEmail`).
const emailConfigured = Boolean(process.env.EMAIL_FROM);

// Auth emails (verification + reset) are rendered + sent through a request-time
// dynamic import for the same config-time-loadability reason as the github
// mirror above: `@/lib/auth-email` pulls in the React-Email renderer + the
// `cloudflare:workers` email binding, neither of which resolves at `void
// prepare`. The Better Auth hooks fire only at request time, so deferring is safe.
function sendVerificationEmail(args: {
  email: string;
  name?: string | null;
  url: string;
}): Promise<void> {
  return import("@/lib/auth-email").then((m) => m.sendVerificationEmail(args));
}
function sendPasswordResetEmail(args: {
  email: string;
  name?: string | null;
  url: string;
}): Promise<void> {
  return import("@/lib/auth-email").then((m) => m.sendPasswordResetEmail(args));
}

// The github-login mirror is imported dynamically (deferred to request time)
// for the same config-time-loadability reason as the dynamic `void/db` /
// `@schema` imports inside the mirror itself: `void prepare` evaluates this
// file in a bare Node context that can't resolve a static `.ts` source import.
// Both account hooks delegate here; the chain-default-then-guard ordering and
// log-on-failure live in `runGithubAccountMirror`.
function mirrorGithubAccount(
  account: MirrorableAccount,
  chainDefault: () => Promise<void> | void,
): Promise<void> {
  return import("@/lib/github-account-mirror").then((m) =>
    m.runGithubAccountMirror(account, chainDefault),
  );
}

export default defineAuth(({ defaults }) => ({
  ...defaults,
  advanced: {
    ...defaults.advanced,
    database: { ...defaults.advanced?.database, generateId: () => ulid() },
  },
  emailAndPassword: {
    ...defaults.emailAndPassword,
    enabled: true,
    // On only when a sender is configured (see `emailConfigured`); unset
    // EMAIL_FROM keeps today's no-verification behavior.
    requireEmailVerification: emailConfigured,
    disableSignUp: !openSignupAllowed,
    // 30 minutes — must match the "expires in 30 minutes" copy in the reset
    // email (`src/emails/reset-password.tsx`). Better Auth's default is 1 hour.
    resetPasswordTokenExpiresIn: 60 * 30,
    sendResetPassword: ({ user, url }) =>
      sendPasswordResetEmail({ email: user.email, name: user.name, url }),
  },
  emailVerification: {
    ...defaults.emailVerification,
    // Send the verification email on signup, and sign the user in once they
    // verify. Only auto-send when a sender is configured.
    sendOnSignUp: emailConfigured,
    autoSignInAfterVerification: true,
    // 24 hours — must match the "expires in 24 hours" copy in the verification
    // email (`src/emails/verify-email.tsx`). Better Auth's default is 1 hour.
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: ({ user, url }) =>
      sendVerificationEmail({ email: user.email, name: user.name, url }),
  },
  socialProviders: {
    ...defaults.socialProviders,
    ...(githubClientId && githubClientSecret
      ? {
          github: {
            clientId: githubClientId,
            clientSecret: githubClientSecret,
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
        after: (account: AccountRow, context: AccountContext) =>
          mirrorGithubAccount(account, () =>
            defaults.databaseHooks?.account?.create?.after?.(account, context),
          ),
      },
      update: {
        ...defaults.databaseHooks?.account?.update,
        after: (account: AccountRow, context: AccountContext) =>
          mirrorGithubAccount(account, () =>
            defaults.databaseHooks?.account?.update?.after?.(account, context),
          ),
      },
    },
  },
}));
