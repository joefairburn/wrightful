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
    R2_ACCOUNT_ID: string;
    R2_BUCKET_NAME: string;
    GREENROOM_MAX_ARTIFACT_BYTES: string;
    GREENROOM_PRESIGN_PUT_TTL_SECONDS: string;
    GREENROOM_PRESIGN_GET_TTL_SECONDS: string;

    // Secrets — set via `wrangler secret put`, not declared in wrangler.jsonc
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
  }
}
