# 2026-04-19 — Streaming ingest via `@wrightful/reporter`

## What changed

Added a Playwright reporter that streams test results to the dashboard as each
test completes, replacing the prior "upload once at end of CI run" workflow
for teams that want live visibility. The existing `wrightful upload` bulk
path (`/api/ingest`) is unchanged — old CLIs and repos that opt not to use
the reporter continue to work exactly as before.

New monorepo package: `packages/reporter` (`@wrightful/reporter`).

Three new dashboard endpoints, gated by a new protocol version:

| method + path                 | purpose                         |
| ----------------------------- | ------------------------------- |
| `POST /api/runs`              | Open a streaming run.           |
| `POST /api/runs/:id/results`  | Append a batch of test results. |
| `POST /api/runs/:id/complete` | Finalize: set terminal status.  |

Protocol version bumped from v2 → v3 (`X-Wrightful-Version`). v1/v2 requests
still accepted.

## Architecture decisions

- **Visibility vs committed flag.** The legacy bulk path uses `runs.committed
= false` during ingest so partially-written runs stay invisible. Streaming
  inverts this: the run needs to be visible from open. Streaming runs go in
  with `committed = true, status = 'running'` and finalize to a terminal
  status on `/complete`. The `committed` flag + `committed_runs` view are
  left intact for the legacy path.
- **Shards converge on one run.** Each Playwright shard spawns its own
  reporter process. We reuse the existing `(projectId, idempotencyKey)`
  unique: deterministic key from CI build id → first shard creates, rest get
  the same `runId` back. Appends are interleaved; aggregates converge.
  `/complete` is idempotent (last-write-wins), matching how CI waits on all
  shards anyway.
- **Fail-closed reporter.** All network errors caught at the reporter
  boundary; warnings go to stderr. Unstreamed batches are written to
  `wrightful-fallback.json` at end of suite. The reporter never fails the
  Playwright suite. (Replay-from-fallback CLI command not shipped in this
  change — out of scope; next CI run provides complete data.)
- **Metadata-only streaming.** The reporter does not upload attachments
  (traces/screenshots/videos) — those continue to flow through the existing
  post-hoc `wrightful upload <playwright-report.json>` path, which detects
  the existing run via idempotency key and attaches artifacts against
  already-streamed test results. Artifact streaming is a follow-up.
- **Result-level idempotency deferred.** The reporter treats un-ack'd batches
  as failures (→ fallback), not as retry candidates. This avoids needing a
  server-side `unique(runId, clientKey)` constraint or upsert semantics, and
  keeps the test_results schema unchanged.
- **Aggregates recomputed live.** Every `/results` append (and `/complete`)
  issues a single correlated-subquery `UPDATE runs SET totalTests=(…),
passed=(…), …`. Cheap on D1 at typical run sizes, avoids a SELECT+UPDATE
  round trip, and keeps the dashboard's run row live with accurate counts.

## Details

### Schema

Single additive change to `runs`:

```sql
ALTER TABLE runs ADD COLUMN completed_at integer;
```

Initial migration was squashed rather than stacked (still pre-launch — see
`feedback_pre_launch_migrations`). Drizzle regenerated
`drizzle/0000_lonely_queen_noir.sql` from the updated `schema.ts` +
`committed_runs` view. The `0000_amused_spitfire.sql` file was replaced.

### Files

| file                                                    | change                                 |
| ------------------------------------------------------- | -------------------------------------- |
| `packages/dashboard/src/db/schema.ts`                   | `runs.completedAt`, view update        |
| `packages/dashboard/drizzle/0000_lonely_queen_noir.sql` | new squashed initial migration         |
| `packages/dashboard/src/routes/api/schemas.ts`          | `Open/Append/Complete` Zod schemas     |
| `packages/dashboard/src/routes/api/runs.ts`             | **new**: 3 handlers + aggregate helper |
| `packages/dashboard/src/routes/api/insert-results.ts`   | **new**: shared batch-insert helper    |
| `packages/dashboard/src/routes/api/ingest.ts`           | refactored to reuse helper             |
| `packages/dashboard/src/routes/api/middleware.ts`       | `PROTOCOL_VERSION_MAX = 3`             |
| `packages/dashboard/src/worker.tsx`                     | mount new routes                       |
| `packages/reporter/`                                    | **new package**                        |

### Reporter package shape

```
packages/reporter/
├── package.json           # peerDep: @playwright/test >=1.40
├── tsconfig.json
├── tsdown.config.ts
├── README.md
└── src/
    ├── index.ts           # default export: WrightfulReporter
    ├── batcher.ts         # debounced batch queue (fail-closed)
    ├── client.ts          # StreamClient (openRun / appendResults / completeRun)
    ├── ci.ts              # detectCI + generateIdempotencyKey (mirror of CLI)
    ├── test-id.ts         # computeTestId (mirror of CLI — must byte-match)
    └── types.ts           # wire types
```

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` — clean.
- `pnpm --filter @wrightful/reporter typecheck` — clean.
- `pnpm --filter @wrightful/reporter test` — 4 passed (batcher debounce,
  size-flush, timer-flush, failure routing, drain).
- `pnpm --filter @wrightful/dashboard test` — 74 passed, 1 pre-existing
  failure (`run-detail-scoping.test.ts` — reproduces on `main`, unrelated).
  New tests in `src/__tests__/runs.test.ts` cover auth 401, validation 400,
  open-fresh, open-idempotent-match, append ownership 404, append batches +
  mapping, complete ownership 404, complete updates.
- `pnpm --filter @wrightful/cli test` — 90 passed.
- `pnpm lint` — 0 errors (9 warnings, all pre-existing shared patterns).
- `pnpm format` applied.

End-to-end manual verification (recommended before merging):

1. `pnpm --filter @wrightful/dashboard dev`.
2. Seed an API key for a local project.
3. Configure `packages/e2e/playwright.config.ts` with
   `reporter: [['list'], ['@wrightful/reporter', { url, token }]]` +
   `WRIGHTFUL_URL` / `WRIGHTFUL_TOKEN` envs.
4. `pnpm test:e2e`. Assert the run appears in the dashboard with
   `status = running` within ~1s of the first test completing, then flips to
   a terminal status on `onEnd`.

## Follow-ups

- Replay CLI: `wrightful upload --fallback wrightful-fallback.json` to re-ingest
  unstreamed results against the existing run (deferred — partial-stream
  failures are rare and next CI run is complete).
- Dashboard UI affordances for `status = 'running'` (loading state on the run
  row, live-updating counts via polling or SSE).

---

## Follow-up round: close semantic gaps vs the bulk CLI path

Initial reporter emitted one row per **attempt** (per `onTestEnd`) and didn't
upload artifacts. Code review surfaced three divergences from the bulk
`wrightful upload` path. All three addressed in this round; no dashboard or
schema changes.

### Gap 1 — flaky represented as `flaky`

**Before:** a retried-then-passed test became two rows (`failed` + `passed`),
never `flaky`. Dashboard flaky counts were always zero for streamed runs.

**After:** reporter now buffers attempts per test and emits **one row per
test at final outcome**. Status is derived from `test.outcome()` —
`expected → passed`, `flaky → flaky`, `skipped → skipped`,
`unexpected → failed|timedout`.

Trade-off: retried tests wait for all attempts before appearing live.
Non-retried tests stream as fast as before (one attempt = immediate enqueue).
Retries are a minority and fire in tight succession, so the live-UX cost is
small and the semantics now match the CLI exactly.

### Gap 2 — incremental artifact uploads

**Before:** reporter sent metadata only; traces/screenshots/videos required
a post-hoc `wrightful upload` call.

**After:** when a test is "done", the reporter walks `result.attachments`
from each attempt, safely resolves paths under `cwd`, and stashes a list
alongside the test payload. After each `/api/runs/:id/results` response
returns the `clientKey → testResultId` mapping, the reporter fires
`/api/artifacts/register` + parallel PUTs (concurrency 4, matching CLI).

New option: `artifacts: 'all' | 'failed' | 'none'`, default `'failed'` —
same semantics as the CLI's `--artifacts` flag. Artifact failures are
fail-closed per-file (warning to stderr, never blocks the run or other
artifacts).

No dashboard changes needed: `/api/artifacts/register` filters on the
`committed_runs` view, and streaming runs are `committed=true` from open,
so they're visible to the artifact endpoint immediately.

### Gap 3 — `durationMs` / `retryCount` match CLI

Collapsed into gap 1 — per-test emission means `durationMs` is now the
sum of attempt durations and `retryCount = attempts - 1`, matching
`packages/cli/src/lib/parser.ts`.

### "Done" detection

Per `onTestEnd(test, result)`, a test is treated as done when:

- `result.status === 'passed'` (Playwright doesn't retry passed).
- `result.status === 'skipped'`.
- `result.status === 'interrupted'` (worker killed — no more attempts).
- `result.retry >= test.retries` (max retries reached).

Any still-pending tests at `onEnd` are flushed anyway so partial data
isn't lost when the run is cut short.

### Files touched (follow-up round)

| file                                                  | change                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/reporter/src/index.ts`                      | per-test buffering + artifact flow                               |
| `packages/reporter/src/client.ts`                     | + `registerArtifacts`, `uploadArtifact`                          |
| `packages/reporter/src/types.ts`                      | + `artifacts` option + artifact types                            |
| `packages/reporter/src/attachments.ts`                | **new** — `classifyAttachment` + safe-path helpers (mirrors CLI) |
| `packages/reporter/src/batcher.ts`                    | made generic (`Batcher<T>`)                                      |
| `packages/reporter/src/__tests__/aggregation.test.ts` | **new** — 13 cases covering done-detection + payload aggregation |
| `packages/reporter/README.md`                         | documents `artifacts` option                                     |

### Verification (follow-up round)

- `pnpm --filter @wrightful/reporter test` — 17 passed (4 batcher + 13 aggregation).
- `pnpm --filter @wrightful/reporter typecheck` — clean.
- `pnpm typecheck` (full repo) — clean.
- `pnpm lint` — 0 errors.
- `pnpm test` (full repo) — 74 passed, 1 pre-existing unrelated failure.

### Dogfooding / example workflow

- `packages/dashboard/fixtures/playwright/playwright.config.ts` now loads
  `@wrightful/reporter` with `artifacts: 'all'`. `scripts/upload-fixtures.mjs`
  no longer shells out to the CLI — a single `npx playwright test` per
  scenario streams results + artifacts via the reporter. CI env vars
  (`GITHUB_ACTIONS`, `GITHUB_RUN_ID`, …) are spoofed in the Playwright
  process env so the reporter stamps branch / build id correctly.
- `packages/e2e/playwright.config.ts` adds the reporter as a third entry
  (alongside `list` + `json`). Reporter no-ops when `WRIGHTFUL_URL` /
  `WRIGHTFUL_TOKEN` aren't set, so local runs stay quiet.
- `examples/github-actions-workflow.yml` switched to reporter-first. CLI
  kept as a documented fallback for users who can't wire a custom reporter.

### CLI removed

After the reporter proved equivalent (same metadata, same artifacts including
mp4 videos, same CI detection), `@wrightful/cli` and `@wrightful/github-action`
were deleted outright. The reporter is now the only way to ingest into the
dashboard.

**What was deleted:**

- `packages/cli/` — the entire `@wrightful/cli` package.
- `packages/github-action/` — wrapped the CLI; superseded by reporter config
  in `playwright.config.ts`.
- `packages/dashboard/src/routes/api/ingest.ts` — the single-shot bulk
  endpoint the CLI hit.
- `packages/dashboard/src/routes/api/insert-results.ts` — shared helper,
  merged back into `runs.ts` (only consumer once `ingest.ts` went).
- `IngestPayloadSchema` + `IngestPayload` type in `schemas.ts`.
- `packages/dashboard/src/__tests__/schemas.test.ts` rewritten to cover the
  v3 open / append / complete schemas directly.
- Root `package.json` `cli` / `test` / `typecheck` scripts referencing
  `@wrightful/cli`.
- `.github/workflows/ci.yml` `test-cli` job + CLI typecheck step; E2E now
  depends on `test-reporter` instead.
- `examples/github-actions-workflow.yml` — CLI fallback paragraph dropped.
- `README.md` + `CLAUDE.md` — updated structure to three packages
  (reporter / dashboard / e2e); install/usage snippet now shows reporter
  config instead of CLI upload.

**Protocol simplification:**

`PROTOCOL_VERSION_MIN` and `PROTOCOL_VERSION_MAX` both collapsed to `3`.
Any `X-Wrightful-Version` less than 3 returns a 409 with a "CLI retired"
message. Middleware test updated to assert this (v2 now rejected).

**Rationale:** the only "benefits" of keeping the CLI were hypothetical
(locked-down CI environments that can run `npx playwright test` but can't
edit `playwright.config.ts` — we couldn't name a real one). The real cost
was duplicated CI detection / artifact collection / test-id computation /
HTTP client, plus a second wire protocol version needing middleware support
forever. Pre-launch, so no customer compatibility to preserve.

Artifacts endpoints (`/api/artifacts/register`, `/api/artifacts/:id/upload`)
stay — the reporter uses them too. Only `/api/ingest` went.

---

## Error handling + stuck-run watchdog

Hardened the reporter's failure path and added a server-side backstop for
runs that can never receive a `/complete` call (CI killed with SIGKILL,
OOM, reporter process crashed).

### Reporter hardening

**Timeouts.** Every `fetch` is now wrapped with `AbortSignal.timeout`:

- 30s for API calls (open / append / complete / register).
- 120s for artifact PUTs (videos can be chunky).

A hung dashboard can no longer wedge the reporter past the test run.

**Retry counts + scope.**

- `fetchWithRetry` gained a `maxRetries` + `timeoutMs` override.
- `completeRun` now retries up to 6 times (vs 3) with backoff 500ms → 8s —
  it's the last-chance finalize; worth the patience.
- `uploadArtifact` now retries on 5xx/network errors (previously: one shot).
  The file is re-opened per attempt via `openAsBlob` so a consumed stream
  doesn't sink the retry.

**Auth errors differentiated.** 401/403 responses throw a new `AuthError`
with a targeted message (`"… rejected — is WRIGHTFUL_TOKEN set correctly?"`)
instead of the generic server error string. No retries on auth (they won't
get better).

**SIGTERM / SIGINT handlers.** Registered in `onBegin`. On signal: mark
the run `'interrupted'` via a quick `/complete` call (3s timeout, no
retry) then exit with the conventional signal-exit code (143 / 130).
GitHub Actions sends SIGTERM before the 10s SIGKILL grace period — this
covers cancellations cleanly. SIGKILL itself is uncatchable; the watchdog
handles it.

**End-of-suite summary.** One stderr line at the end of `onEnd`:

```
[wrightful] streamed 42/44 test(s); uploaded 7/7 artifact(s); 2 result(s) dropped.
```

Appears even on success. If `completeRun` failed, adds
`complete call failed — watchdog will finalize`.

**Removed the fallback JSON file.** No tool replayed it; keeping it was
misleading. `failedBatches` + `writeFallback` + `fallbackPath` option all
deleted. Recovery story is now just "re-run CI" — the deterministic
idempotency key ensures the same `runId` and the watchdog cleans up any
orphan.

### Dashboard watchdog (new)

Cloudflare Workers Cron Trigger running every 5 minutes, configured in
`wrangler.jsonc`:

```jsonc
"triggers": { "crons": ["*/5 * * * *"] }
```

Handler at `packages/dashboard/src/scheduled.ts` sweeps for stuck runs:

```sql
UPDATE runs
   SET status = 'interrupted', completed_at = now()
 WHERE status = 'running'
   AND created_at < now() - INTERVAL stale_minutes
```

- **Stale threshold**: 30 minutes default, overridable via
  `WRIGHTFUL_RUN_STALE_MINUTES` env.
- **Status `'interrupted'`** matches Playwright's `FullResult` vocabulary,
  distinct from a clean `'failed'` so UI can flag these specifically.
- **Never deletes data** — only flips the status. Operators can inspect
  the partial data and re-run CI to overwrite the run via its idempotency
  key.
- Emits structured JSON log lines (`watchdog.run_interrupted`,
  `watchdog.sweep_complete`, `watchdog.sweep_failed`) for post-hoc
  troubleshooting in Workers logs.

Mounted alongside `fetch` via `Object.assign(app, { scheduled: ... })` so
rwsdk's `AppDefinition` shape (with `__rwRoutes`) is preserved — the
`linkFor<App>()` type inference used throughout the UI still works.

### Files touched (error-handling round)

| file                                                 | change                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/reporter/src/client.ts`                    | timeouts, `AuthError`, artifact retries, `completeRun` retry override |
| `packages/reporter/src/index.ts`                     | signal handlers, summary, counters; fallback file removed             |
| `packages/reporter/src/types.ts`                     | `fallbackPath` removed from `ReporterOptions`                         |
| `packages/reporter/README.md`                        | documents retry / watchdog semantics                                  |
| `packages/dashboard/wrangler.jsonc`                  | `triggers.crons` + `WRIGHTFUL_RUN_STALE_MINUTES` var                  |
| `packages/dashboard/src/scheduled.ts`                | **new** — `sweepStuckRuns` + `scheduledHandler`                       |
| `packages/dashboard/src/worker.tsx`                  | wraps default export with `scheduled`                                 |
| `packages/dashboard/src/__tests__/scheduled.test.ts` | **new** — 4 cases                                                     |
| `packages/dashboard/worker-configuration.d.ts`       | regenerated to include new env var                                    |

### Verification (error-handling round)

- `pnpm --filter @wrightful/reporter test` — 17 pass (unchanged).
- `pnpm --filter @wrightful/reporter typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — +4 new scheduled tests.
- `pnpm typecheck` / `pnpm lint` — clean.
- **Manual smoke (recommended before deploy)**:
  1. Seed a run with `status='running', created_at=now-3600s`.
  2. `pnpm --filter @wrightful/dashboard exec wrangler dev --test-scheduled`.
  3. Hit `/cdn-cgi/mf/scheduled` to trigger the cron; assert status flips to `'interrupted'`.
  4. Run Playwright, `kill -TERM <pid>` mid-suite; confirm the `/complete` call with `status='interrupted'` fires before the process exits.
