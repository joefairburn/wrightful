# 2026-05-02 — Better Auth secondary storage on Cloudflare KV

## What changed

Better Auth supports a `secondaryStorage` abstraction (`{ get, set, delete }`) that, when configured, becomes the storage layer for **sessions** (and rate-limit counters) instead of the primary database. Verifications and accounts stay on the primary DB unless explicitly opted in. This worklog wires Cloudflare KV into that slot for sessions.

**Zero setup for self-hosters.** Wrangler auto-provisions KV (and R2 / D1) when the binding is declared without an `id` — same pattern as our existing R2 bucket. First `wrangler deploy` creates a namespace prefixed with the worker's name and writes the id back to `wrangler.jsonc`. No `wrangler kv namespace create` step required.

## Why this is meaningful even with the recent DO fixes

Today's DO worklog (`2026-05-02-do-init-fixes.md`) addressed the cold-init race and the doubled-RPC count, which kills the **multi-second** spikes. KV secondary storage attacks a different layer: the **cookie-cache-miss path**. Every 5 minutes per active user, the signed cookie expires and Better Auth refreshes the session — that's currently a ControlDO RPC (~50–250 ms typical). With KV, that miss path becomes a ~1–10 ms KV read, and the ControlDO is touched only on miss-after-miss (rare).

In short: the DO fix removes the worst-case spikes; the KV fix lowers the steady-state latency floor and removes a category of ControlDO traffic entirely.

## Code change

| File                                        | Change                                                                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/wrangler.jsonc`         | Added `kv_namespaces` block with binding `AUTH_KV` and **no `id`** — wrangler auto-provisions on first deploy.                                                                                                                          |
| `packages/dashboard/types/env.d.ts`         | Declared `AUTH_KV?: KVNamespace` (optional in the type so vitest, which has no env binding, still typechecks).                                                                                                                          |
| `packages/dashboard/src/lib/better-auth.ts` | Added `buildSecondaryStorage(kv)` helper and a conditional `secondaryStorage = env.AUTH_KV ? buildSecondaryStorage(env.AUTH_KV) : undefined` in `buildAuth()`. Stateless sessions (Better Auth default once `secondaryStorage` is set). |

The `buildSecondaryStorage` helper clamps Better Auth's TTL to KV's minimum 60 s — defensive only; Better Auth's real TTLs are always well above that.

## Mode picked: stateless (KV-only sessions)

Better Auth's two operating modes when secondary storage is provided:

- **Stateless** (default when `secondaryStorage` is set): sessions live in KV only. `storeSessionInDatabase: false`.
- **Dual-write**: sessions live in both KV and the primary DB. `storeSessionInDatabase: true`.

We picked stateless. What lives where:

| Stored where       | What                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KV (`AUTH_KV`)** | `session` records (and rate-limit counters, if/when we wire them through Better Auth).                                                                                                                                      |
| **ControlDO**      | `user`, `account` (OAuth links), `verification` (OAuth/email tokens — could be moved to KV later via `verification.storeInDatabase: false`, not done here), and all our app tables (`teams`, `projects`, `memberships`, …). |

Reasoning:

- **Sessions are pure cache.** They expire (7 days), users re-auth all the time. No transactional state lives in a session record. Treating them like persistent data was conservative cargo-culting on my part.
- **Revocation lag is gated by the cookie cache (5 min), not the storage layer.** Sign-out → other devices' cookies stay valid up to 5 min in either mode. KV's ~60 s global propagation is irrelevant when the cookie's good for 300 s.
- **Halves session-related ControlDO writes.** No more session inserts on the singleton during traffic bursts.
- **Smaller failure surface.** Dual-write would require both KV and ControlDO to succeed on every sign-in / refresh; stateless narrows that to "KV must be up". One less source of `auth-write-failed` errors.
- **KV eviction risk is real but trivial.** Cloudflare KV doesn't actively evict in normal operation. If it ever did: the user re-auths. Same outcome as their session naturally expiring slightly earlier.

## Setup for self-hosters

Nothing. `wrangler deploy` provisions the KV namespace automatically on first deploy and writes the id back to your local `wrangler.jsonc` (as long as you deploy from a checkout of the repo — CI deploys without push-back will create the namespace but only show the id in the dashboard).

For local `wrangler dev`, Miniflare auto-creates a local KV namespace under `.wrangler/state` that persists across runs.

If a deployment ever ships without the binding present (e.g. CI deploy on first run, dashboard not yet caught up), the better-auth factory falls back to ControlDO-only sessions — that's the conditional `env.AUTH_KV ?` check in `lib/better-auth.ts`. No outage; just slower until KV is in the env.

## Verification

| Check                                          | Result                            |
| ---------------------------------------------- | --------------------------------- |
| `pnpm --filter @wrightful/dashboard typecheck` | Clean                             |
| `pnpm --filter @wrightful/dashboard test`      | 167 / 167 passed                  |
| `pnpm lint`                                    | 31 warnings, 0 errors (unchanged) |

Manual checks after enabling the binding in production:

- Cloudflare observability: filter on `$workers.entrypoint = "ControlDO"` AND `$metadata.message contains "session"` (or whatever your better-auth session table is). Read volume on the sessions table should drop substantially.
- KV dashboard → AUTH_KV namespace: should show steady reads/writes proportional to active sessions and sign-ins.
- Sign out from device A → next request on device B should redirect to login within the cookie cache TTL window (5 min), as today. Revoke flow unchanged.

## What we did not do

- **Move verifications to KV** via `verification.storeInDatabase: false`. Verification tokens (OAuth state, email confirmation) are infrequent and short-lived; ControlDO traffic from them is negligible. Trivial to flip later if we ever care.
- **API key plugin / API key reads.** Wrightful uses its own custom Bearer-key auth (`src/lib/auth.ts`), not Better Auth's `apiKey` plugin. Adding KV to the streaming-ingest path would require migrating that helper's lookup to KV separately. Not in scope here.
- **Worker Cache API** as an alternative to KV. KV is the documented Better Auth pattern and gives us colo-replicated reads; the Cache API is per-colo. KV is the right primitive for this.
