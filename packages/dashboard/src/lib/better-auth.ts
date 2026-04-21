import { betterAuth } from "better-auth";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { ulid } from "ulid";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { refreshUserOrgs } from "@/lib/github-orgs";

export function hasGithubOAuthConfigured(): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function getGithubOAuthCreds():
  | { clientId: string; clientSecret: string }
  | undefined {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

function buildAuth() {
  const publicUrl = env.WRIGHTFUL_PUBLIC_URL;
  const secret = env.BETTER_AUTH_SECRET;

  if (!publicUrl || !secret) {
    throw new Error(
      "Wrightful requires WRIGHTFUL_PUBLIC_URL and BETTER_AUTH_SECRET. Set them in wrangler.jsonc / .dev.vars. Generate BETTER_AUTH_SECRET with `openssl rand -base64 32`.",
    );
  }

  // GitHub OAuth is optional. Self-hosters who just want email/password can
  // skip registering a GitHub OAuth app entirely.
  const githubCreds = getGithubOAuthCreds();
  const socialProviders = githubCreds
    ? {
        // `read:org` is required so we can list the user's GitHub
        // organisations and surface teams that auto-grant access based
        // on org membership.
        github: { ...githubCreds, scope: ["read:org", "user:email"] },
      }
    : undefined;

  return betterAuth({
    baseURL: publicUrl,
    secret,
    // kyselyAdapter uses Better Auth's default camelCase field names
    // (`userId`, `emailVerified`, …). Our Kysely instance installs
    // CamelCasePlugin, so those map to the existing snake_case columns.
    database: kyselyAdapter(getDb(), { type: "sqlite" }),
    advanced: {
      // Keep Wrightful's ULID convention for user/session/account/verification ids.
      database: { generateId: () => ulid() },
    },
    emailAndPassword: {
      enabled: true,
      // Email sending isn't wired up; verification would block sign-up.
      // Flip this on once an email provider is configured.
      requireEmailVerification: false,
    },
    socialProviders,
    databaseHooks: {
      account: {
        // Pre-warm the user's GitHub-org cache on their first OAuth login
        // (and on any re-auth that updates the token — e.g. scope upgrade).
        // Awaited so `/` (team picker) renders with a populated suggestion
        // list without us having to refresh on every page render. Failures
        // are swallowed: the profile page still exposes a manual refresh.
        create: {
          after: async (account) => {
            if (account.providerId !== "github") return;
            try {
              await refreshUserOrgs(account.userId);
            } catch {
              // Best effort — don't block sign-in on a GitHub API hiccup.
            }
          },
        },
        update: {
          after: async (account) => {
            if (account.providerId !== "github") return;
            try {
              await refreshUserOrgs(account.userId);
            } catch {
              // Best effort.
            }
          },
        },
      },
    },
  });
}

let cached: ReturnType<typeof buildAuth> | null = null;

export function getAuth(): ReturnType<typeof buildAuth> {
  if (!cached) cached = buildAuth();
  return cached;
}
