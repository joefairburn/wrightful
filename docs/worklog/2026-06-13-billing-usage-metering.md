# 2026-06-13 — Billing: usage metering + quota enforcement (roadmap 1.1)

## What changed

Added per-team **usage metering** and **quota enforcement** — the first launch-blocker from `docs/roadmap/` Tier 1. The dashboard now meters ingest volume (runs, test results, artifact bytes) per team-month and blocks ingest over the team's tier allowance. Built Stripe-agnostic: enforcement keys off a `teams.tier` column that a Stripe webhook can later flip; no payment integration in this change.

Two deliberately separate layers:

- **Metering** — a live counter table `usageCounters` (one row per `(teamId, periodStart)`, where `periodStart` is the UTC start-of-month epoch-seconds). It is bumped in the **same `db.batch`** as the ingest write it meters, via `usageBumpStatement` wired into `openRun` (fresh open → `runs +1`), `appendRunResults` (fresh testResults rows only), and `registerArtifacts` (fresh artifact bytes + count). Counting fresh rows only means a re-streamed/retried flush or idempotent artifact re-registration never double-counts.
- **Enforcement** — `checkQuota` reads the team's tier + current-period usage and classifies `ok | softWarn | blocked` against the tier limits. The **runs** dimension is gated at `POST /api/runs` (the synthetic-monitor path calls `openRun` directly and is intentionally exempt, so monitoring never stops on a CI-run quota). **Artifact bytes** are gated inside `registerArtifacts` on _fresh_ bytes (so an idempotent retry at the limit still succeeds). **testResults** is metered + surfaced but not hard-blocked in v1.

A daily reconciliation cron (`rollup-usage`) recomputes each team's current-period counters from the authoritative `runs`/`testResults`/`artifacts` rows and re-bases the live meter — the safety net for drift (chiefly future retention deletes inside the current window).

A read-only **Usage** settings page (`/settings/teams/:slug/usage`, any member) shows current-period meters as bars against the tier limits, with a sidebar nav entry.

## Details

| Area      | Change                                                                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema    | `teams.tier` (text, default `"free"`); new `usageCounters` table (`id`, `teamId` FK cascade, `periodStart`, `runsCount`, `testResultsCount`, `artifactBytes`, `artifactCount`, `updatedAt`) + unique index `(teamId, periodStart)`. Migration `20260613162020_solid_echo.sql`. |
| Env       | `WRIGHTFUL_FREE_MONTHLY_RUNS` (1000), `WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS` (100000), `WRIGHTFUL_FREE_ARTIFACT_BYTES` (5 GiB), `WRIGHTFUL_QUOTA_SOFT_WARN_PCT` (90).                                                                                                           |
| Lib       | New `src/lib/usage.ts`: `monthStartSeconds`, `formatBytes`, `tierLimits`, `evaluateQuota` (pure), `usageBumpStatement`, `checkQuota`, `loadTeamUsage`, `reconcileUsage`.                                                                                                       |
| Ingest    | `openRun` + `appendRunResults` append `usageBumpStatement` to their existing batch.                                                                                                                                                                                            |
| Artifacts | `registerArtifacts` gains a `quotaExceeded` result variant + meters fresh bytes/count in-batch.                                                                                                                                                                                |
| Routes    | `POST /api/runs` → 429 on blocked runs quota + `X-Wrightful-Quota-Warning` header on soft-warn; `POST /api/artifacts/register` → 429 on `quotaExceeded`.                                                                                                                       |
| Cron      | New `crons/rollup-usage.ts` (`0 3 * * *` — distinct from the five-minute reaper family).                                                                                                                                                                                       |
| UI        | New `pages/settings/teams/[teamSlug]/usage.{server.ts,tsx}` + "Usage" nav link in `app-layout.tsx`.                                                                                                                                                                            |

## Design notes

- **Why metering is in-batch but runs-enforcement is at the route.** The meter must be atomic with the data, so it rides the existing `db.batch`. Runs enforcement lives at the route (not in `openRun`) so the synthetic-monitor path — which calls `openRun` directly — stays exempt, and so `openRun`'s return contract is unchanged. The one accepted edge: a CI re-run (duplicate open) of the run sitting exactly at the limit is also 429'd.
- **Why artifact enforcement is in-lib.** Byte enforcement needs the _fresh_ byte count, which is only known after `planArtifactRegistration`. Enforcing there (vs at the route on declared payload bytes) keeps idempotent retries working at the limit (a pure retry plans 0 fresh rows → never blocked).
- **`Infinity` limits → `null` at the page boundary.** Non-free tiers are unlimited; `Infinity` doesn't survive JSON, so the loader maps it to `null` ("Unlimited").

## Verification

- `vp exec tsgo --noEmit` — clean.
- `vp test run` — **879 passed (82 files)**. New `src/__tests__/usage.test.ts` covers the pure core (`evaluateQuota` boundaries, `monthStartSeconds`, `formatBytes`, `usageBumpStatement` no-op). The fragile FIFO-stub pipeline suites (`ingest-pipeline`, `artifacts-pipeline`) were updated for the new in-batch meter statement + the `checkQuota` read (added `onConflictDoUpdate`/`leftJoin`/`sql` to their `void/db` stubs, a `void/env` mock for the artifact suite, and the openRun batch-length assertion 2→3).
- `vp check --fix` — 0 errors (70 pre-existing reporter `no-unsafe-type-assertion` warnings unrelated to this change).
- `void db generate` — migration generated and inspected.
- Not yet exercised: end-to-end ingest against a live D1 (the DB-touching `checkQuota`/`reconcileUsage` paths are only covered by the e2e dogfood suite, per the standing real-D1-harness gap).
