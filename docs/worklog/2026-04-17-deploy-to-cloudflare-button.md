# 2026-04-17 — Self-deploy via Cloudflare "Deploy to Cloudflare" button

## What changed

Shaped `packages/dashboard` so anyone can spin up their own Wrightful dashboard with a single click via Cloudflare's "Deploy to Cloudflare" button. Provisions D1, R2, and Worker bindings directly from `packages/dashboard/wrangler.jsonc`. The deploy URL scopes into the subdirectory (`.../tree/main/packages/dashboard`) since Cloudflare treats the subdir as the project root.

Reference: https://developers.cloudflare.com/workers/platform/deploy-buttons/

## Details

| Area                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.jsonc`           | `database_id` placeholder → empty (Cloudflare writes the new id on provisioning); `compatibility_date` bumped `2025-08-21` → `2026-04-17`                                                                                                                                                                                                                                                                                        |
| `package.json`             | Added `cloudflare.bindings` descriptions (shown in the deploy UI); new `deploy` script chains `db:migrate:remote && wrangler deploy` so migrations auto-apply on every deploy (including the first); new `db:seed-api-key` script. Migration commands reference the `DB` binding (not the database name `wrightful`), per Cloudflare's deploy-button guidance, so deployers can rename the database without breaking the scripts |
| `.dev.vars.example`        | New — declares `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` so the deploy UI prompts for them                                                                                                                                                                                                                                                                                                                                     |
| `scripts/seed-api-key.mjs` | New — generates a `wrf_live…` key, SHA-256-hashes it to match `src/lib/auth.ts`, inserts via `wrangler d1 execute`, prints the raw key once                                                                                                                                                                                                                                                                                      |
| Root `README.md`           | New — project overview, deploy button, post-deploy checklist, local dev quickstart                                                                                                                                                                                                                                                                                                                                               |

## Why a seed script instead of a bootstrap endpoint

Considered exposing a one-shot `/bootstrap` endpoint that seeds the first API key on first hit. Rejected: adds a permanently reachable endpoint that has to be correct under race conditions and can't leak, for a problem that only exists once per deployment. `wrangler d1 execute` from the maintainer's machine is already authenticated via the same token used for deploy, and the script (`scripts/seed-api-key.mjs`) keeps the key generation + hashing logic identical to `src/lib/auth.ts:hashKey`.

## Unavoidable manual step

R2 API tokens (the S3-compatible access key pair used by `src/lib/r2-presign.ts`) cannot be auto-provisioned — Cloudflare's deploy flow creates the bucket but not the credential pair. The README's post-deploy checklist walks the deployer through creating the token and running `wrangler secret put` twice. Switching artifact uploads to use the native R2 binding directly (no S3 presigning) would eliminate this — tracked as out-of-scope follow-up.

## Verification

- `pnpm lint`, `pnpm format`, `pnpm typecheck` — clean.
- `pnpm --filter @wrightful/dashboard build` — builds clean.
- `pnpm --filter @wrightful/dashboard exec wrangler deploy --dry-run --config dist/worker/wrangler.json` — wrangler parses the edited config, prints all bindings (`DB`, `R2`, `ASSETS`, vars) correctly.
- `pnpm test` — 126 tests pass.
- End-to-end deploy button flow will be smoke-tested against a scratch Cloudflare account once merged; not exercised locally since it mutates real Cloudflare state.

## Follow-up: `database_id` must be non-empty for local dev

The initial draft blanked `d1_databases[0].database_id` entirely
(`""`). That broke `pnpm dev` and `pnpm test:e2e`: miniflare asserts
`databaseId` is truthy while building its explorer binding map, and
aborts vite dev-server startup with `AssertionError: (databaseId)`. The
deploy flow overwrites the value with the provisioned D1 UUID
regardless, so a placeholder string is fine. Restored the pre-existing
`"LOCAL_PLACEHOLDER"` sentinel (with a comment explaining why it has to
be non-empty). `pnpm test:e2e` now boots the dev server and all 12
tests pass.
