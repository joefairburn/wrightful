# 2026-06-13 — Public / shareable run links (roadmap 1.4)

## What changed

A run can now be shared as a **signed, read-only public link** (`/share/run/:token`) that renders without a session — for dropping a failing run into a PR, a Slack thread, or to someone outside the team. The link is revocable.

Mirrors the existing artifact-token capability model: an HMAC-signed token carries the run/project/team ids and an expiry; the public loader verifies it statelessly, then launders the (authenticity-proven) ids into a `TenantScope` via `makeTenantScope` — the sanctioned 4th scope producer. A `runShares` row backs each link so it can be **revoked** before expiry (the loader checks `revokedAt` by token hash).

The public page is a self-contained, chrome-free read-only view: run summary (status, counts, duration, branch/commit/env) + the test results list. No app sidebar, no auth, no live updates — a static snapshot.

A "Share" control in the run-detail header (a small client island) mints / copies / revokes the link.

## Details

| Area   | Change                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema | New `runShares` table (`id`, `runId`/`projectId`/`teamId` FK cascade, `tokenHash` unique, `createdBy`, `createdAt`, `expiresAt`, `revokedAt`). Only the SHA-256 of the token is stored. Migration `20260613164459_quiet_network.sql`. |
| Env    | `SHARE_TOKEN_SECRET` (optional; falls back to `BETTER_AUTH_SECRET`).                                                                                                                                                                  |
| Config | `resolveShareTokenSecret(source)` in `src/lib/config.ts`.                                                                                                                                                                             |
| Lib    | `src/lib/share-tokens.ts` — `signShareToken`/`verifyShareToken` (HMAC, default 30-day TTL), `shareTokenHash`, `shareRunPath`.                                                                                                         |
| Routes | `routes/api/t/[teamSlug]/p/[projectSlug]/runs/[runId]/share.ts` — `POST` mints (member-authed), `DELETE` revokes all active links for the run.                                                                                        |
| Pages  | `pages/share/run/[token]/{index.server.ts,index.tsx}` — anonymous read-only run view.                                                                                                                                                 |
| UI     | `src/components/share-run-button.tsx` island, wired into the run-detail header.                                                                                                                                                       |

## Design notes

- **No middleware change needed.** `middleware/01.context.ts` only redirects anonymous visitors away from `/t/*` and `/settings`; `/share/*` already falls through to render anonymously. Confirmed by reading the middleware rather than assuming.
- **Stateless auth + stateful revocation.** The HMAC proves the token wasn't forged and carries the ids (no DB read to identify the run); the `runShares` lookup adds revocation + a belt-and-suspenders existence check. Rotating `SHARE_TOKEN_SECRET` invalidates every link at once.
- **Scope slugs are empty.** The token carries ids, not slugs (slugs can change on rename). The read paths (`loadRunResultsPage`, `runByIdWhere`) only use `projectId`, and the public view builds no tenant-relative URLs, so `makeTenantScope` gets empty slugs — documented at the call site.
- **Artifacts deferred.** v1 shows results (pass/fail per test) but not downloadable traces/screenshots on the public view. Re-minting artifact tokens for the anonymous page is a noted follow-up (`docs/roadmap/1.4`).

## Verification

- `vp exec tsgo --noEmit` — clean.
- `vp test run` — **898 passed (86 files)**. New `src/__tests__/share-tokens.test.ts` (sign/verify round-trip, tamper/expiry rejection, token-hash shape, URL shape).
- `vp check` — 0 errors (74 warnings: pre-existing reporter set + the new `response.json() as T` casts in the GitHub + share code, matching the established idiom).
- `void db generate` — migration generated and inspected.
- Not exercised end-to-end: minting via the island against a live session + opening the link anonymously (the token crypto + revocation logic are unit-tested; the DB/route wiring is covered by the e2e dogfood suite per the standing real-D1-harness gap).
