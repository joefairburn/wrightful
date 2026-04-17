import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { ulid } from "ulid";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import * as schema from "@/db/schema";

export function hasGithubOAuthConfigured(): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
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
  const socialProviders = hasGithubOAuthConfigured()
    ? {
        github: {
          clientId: env.GITHUB_CLIENT_ID as string,
          clientSecret: env.GITHUB_CLIENT_SECRET as string,
        },
      }
    : undefined;

  return betterAuth({
    baseURL: publicUrl,
    secret,
    database: drizzleAdapter(getDb(), { provider: "sqlite", schema }),
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
  });
}

let cached: ReturnType<typeof buildAuth> | null = null;

export function getAuth(): ReturnType<typeof buildAuth> {
  if (!cached) cached = buildAuth();
  return cached;
}
