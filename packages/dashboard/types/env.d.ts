// Augments the wrangler-generated `Cloudflare.Env` so:
//   1. `vars` in wrangler.jsonc are typed as `string` rather than the literal
//      value wrangler emits at type-gen time (e.g. `R2_ACCOUNT_ID: ""`).
//   2. Secrets (set via `wrangler secret put`) are declared — wrangler can't
//      see them at type-gen time, so they're missing from the generated file.
//
// Keep this file in lock-step with wrangler.jsonc's `vars` block and the
// secrets documented in docs/worklog/2026-04-16-phase2-m1-artifact-upload.md.

// No top-level import/export on purpose — this file must be a TypeScript
// "script" so that `declare namespace Cloudflare` merges into the namespace
// declared by worker-configuration.d.ts rather than creating a module-local
// one.

declare namespace Cloudflare {
  interface Env {
    // Widen vars (wrangler emits literal types from wrangler.jsonc values)
    WRIGHTFUL_MAX_ARTIFACT_BYTES: string;

    // Required: public origin of the dashboard. Used by Better Auth for
    // OAuth callback URLs and artifact download token audiences. Set in
    // Workers & Pages → Settings → Variables; intentionally NOT declared
    // in wrangler.jsonc so `--keep-vars` can preserve the dashboard value
    // across deploys. Locally, set in `.dev.vars`.
    WRIGHTFUL_PUBLIC_URL: string;

    // Secrets — set via `wrangler secret put` (or .dev.vars locally).

    // Required: signing secret for Better Auth sessions.
    BETTER_AUTH_SECRET: string;
    // Optional: enable GitHub OAuth by setting both.
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    // Optional: set to "1"/"true"/"yes"/"on" to permit email/password signup.
    // Defaults to disabled because email verification isn't wired up yet.
    ALLOW_OPEN_SIGNUP?: string;

    // Native rate-limit bindings (configured in wrangler.jsonc#ratelimits).
    AUTH_RATE_LIMITER: RateLimit;
    API_RATE_LIMITER: RateLimit;
    ARTIFACT_RATE_LIMITER: RateLimit;

    // KV namespace used as Better Auth's `secondaryStorage` for sessions.
    // Auto-provisioned by Cloudflare on first `wrangler deploy` via the
    // binding-without-id pattern in wrangler.jsonc. Optional in the type
    // because tests (vitest) don't have an env binding and our better-auth
    // factory checks for it before wiring secondaryStorage.
    AUTH_KV?: KVNamespace;
  }
}
