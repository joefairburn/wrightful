# 2026-06-10 — Re-review remediation (closure policy rework, feed policy moved client-side, shard key revert)

## What changed

A second review pass over the 2026-06-09 review-fix campaign (7 finder angles
plus adversarial verification over the full working-tree diff) confirmed 14
real findings — several of them **interactions between the campaign's own
fixes**. This entry records the remediation. It supersedes specific claims in
the 2026-06-09 worklogs where noted.

## Ingest: closure policy reworked around ACTIVITY (supersedes the completedAt-only guard)

The 2026-06-09 `runClosedForResults` guard (refuse /results 30 min after
`completedAt`) broke every legitimate re-stream: CI job re-runs share their
idempotency key BY DESIGN (that determinism is what lets a re-run recover the
run row), unbalanced shards stream past a sibling's /complete, and the seeders
re-open fixed-key backdated runs. All of them would have 409'd and the
reporter drops 4xx batches silently.

Rework (`src/lib/ingest.ts`):

- `runClosedForWrites` replaces it: a run refuses ingest writes only when
  terminal AND **idle** past `RUN_WRITE_GRACE_SECONDS` (30 min) — the window
  keys on `max(completedAt, lastActivityAt)`, so accepted writes keep sliding
  it and active flows are never cut off.
- `openRun`'s duplicate path (and its unique-violation recovery path) now
  RE-ARMS the window (`reopenRunForWrites` bumps `lastActivityAt`). Every
  legitimate flow starts with an open, which requires the run's
  **idempotency key** — a value that never leaks into URLs or PR comments —
  while a stolen **runId** (those DO leak) cannot reopen an idle terminal
  run. That asymmetry is the security bar.
- The policy now covers **all four ingest writes** (it previously guarded only
  /results, leaving the documented threat open via the siblings):
  `appendRunResults`, `completeRun` (a leaked key could escalate a months-old
  `passed` run to `failed` via the severity merge), `registerArtifacts` (the
  idempotent path hands back OVERWRITE upload URLs), and
  `storeArtifactUpload` (artifact ids leak into dashboard URLs; the owning
  run is resolved via a testResults→runs join). All map to 409.

## Project feed: synthetic policy moved CLIENT-side (supersedes publish-time suppression)

2026-06-09 suppressed synthetic runs' project-feed events at publish time —
which made the same change set's own runs-list origin toggle ("Monitors" /
"All" views) render frozen rows that never update live. Reverted: ingest
broadcasts every run's feed events again; `run-created` events now carry
`origin`; `RunListRowData` gains `origin`; the reducer
(`applyProjectFeedEvent`) accepts a `ProjectFeedView { acceptNewRuns, origin }`
and prepends only rows matching the active view. The runs-list page treats the
origin toggle as a _view_ (not a prepend-disqualifying filter). One policy
site, where the active view is actually known.

## Reporter (`@wrightful/reporter`)

- **Shard discriminator REVERTED** (job-name discriminator kept): the
  2026-06-09 `-shard-N-M` idempotency suffix made each `--shard` open its own
  dashboard run, contradicting the server's deliberate shard-merge design
  (queue prefill `onConflictDoNothing`, monotonic cross-shard /complete
  merge) and turning the PR comment into a last-shard-wins partial tally.
  Shards and matrix legs of one suite share a run again; distinct _jobs_
  still get distinct keys via `GITHUB_JOB`/`CI_JOB_NAME`.
- **Mid-run AuthError no longer skips /complete**: a `streamingDisabled` flag
  replaces the client-nulling — doomed /results POSTs stop (warn once,
  batches dropped locally), but onEnd still attempts `/complete` exactly once
  (server-side recompute makes a successful complete strictly better; a
  genuinely revoked key costs one caught warning).
- **onEnd always STARTS `batcher.drain()`**: the deadline chain previously
  short-circuited before invoking it, dropping fully-buffered batches that a
  healthy /results endpoint could have absorbed. The drain now starts
  unconditionally (rejection-guarded, keeps running unawaited); only the
  await is budget-bounded.
- `settleWithinDeadline` is now a thin wrapper over `withDeadline` (one timer
  primitive instead of two divergent copies).

## Dashboard: remaining confirmed findings

- **Missed synthetic-exclusion surfaces** (the 2026-06-09 claim that the
  scope-join covered "every analytics surface" was wrong): insights landing
  KPIs, suite-size (all four queries), flaky's PRIMARY ranking aggregate and
  sparkline, and the branch-options query now exclude monitor traffic via two
  new shared seams — `ciRunsScopeWhere(scope)` (scope.ts) and
  `ciRunsJoinFragment()`/`ciRunsJoinOn()` (analytics/filters.ts, replacing
  the branch-conditional `branchJoinFragment` whose conditional join was the
  correctness hole). `runScopeWhere`/`runByIdWhere` deliberately keep seeing
  synthetic runs (run detail, monitors pages, the origin toggle).
- **`leaveTeam` last-owner guard made atomic**: the owner-count check moved
  INSIDE the DELETE (subquery in the WHERE, verified via `.returning()`), so
  the last two owners leaving concurrently can no longer strand the team
  ownerless. `countOwners` deleted.
- **WS Origin gate accepts same-origin**: `isAllowedWsOrigin` now allows an
  Origin whose host equals the upgrade request's own Host (plus the
  `WRIGHTFUL_PUBLIC_URL` origin as belt-and-braces) — a second legitimate
  origin (workers.dev + custom domain, dev port drift) no longer suffers a
  silent realtime blackout; cross-site origins still 403.
- **Team/project delete R2 sweeps moved to `waitUntil`**: the inline sweep
  (up to ~200 R2 subrequests per project) no longer blocks the user's
  redirect; failures still log.
- **Run-room reconnect → coalesced `router.refresh()`** (replaces the
  summary-only fetch, which left per-test rows broadcast during a WS drop
  permanently missing from the Tests list): the loader re-runs and the
  prop-identity reseed folds fresh tests + summary in. One refresh per
  reconnect burst across all leaves (`requestReconnectRefresh`, shared with
  the project room). The entire fetch/abort/identity-guard machinery in
  `use-run-room.ts` is deleted; the reseed block is now the shared
  `useSeededState` hook used by both room hooks.
- **`pr-url.ts` accepts `ciProvider: "github"`** (the seed generator emits
  it) alongside `github-actions`, via one shared predicate — seeded runs keep
  their branch/commit links.
- **INGEST_IP_RATE_LIMITER raised to 1200/min** with an honest comment:
  authenticated traffic consumes the bucket too, so it caps the combined
  ingest rate per egress IP (~10 saturating keys); self-hosters with bigger
  single-IP fleets should raise it.
- **Sandbox exec-timeout message softened**: classification is elapsed-time
  only, so the recorded error now names both readings (script hang vs runner
  interrupted at the deadline) instead of definitively blaming the script.
- **Invite-form hint** (members page): email invites match verified emails
  only (currently GitHub sign-ins) — owners are told to invite password
  accounts by GitHub username instead.

## Cleanups folded in

Shared `tooManyRequests` 429 helper (02 + 03 middlewares); `mutationErrorMessage`
delegates to `isUniqueViolation` (one home for D1's error-text probe);
`registerArtifacts`' race retry restructured as an internal loop (re-runs only
the read+plan+insert section; the public `retriedAfterRace` parameter is gone);
`resolveTestResultIds` chunk reads run via `Promise.all` (~52 serial
round-trips on a max-size batch otherwise); `parseOrigin` validates against
`RUN_ORIGIN_FILTERS` (the constant is no longer dead); `finalizeStaleRun`'s
optional `origin` param removed with the suppression revert.

## Verification

| Check                                       | Result                             |
| ------------------------------------------- | ---------------------------------- |
| `pnpm check`                                | exit 0 — 0 errors                  |
| Dashboard typecheck (`void prepare` + tsgo) | clean                              |
| Dashboard unit tests                        | 73 files, 775/775                  |
| Reporter unit tests                         | 14 files, 233/233                  |
| Dashboard + reporter builds                 | pass                               |
| API e2e (`pnpm test:e2e`)                   | 12/12                              |
| Dashboard UI e2e                            | 37 passed, 1 skipped (visual gate) |

The UI e2e suite repeats its known load-dependent flake pair under 3 local
workers (monitors cycle, test-detail navigation) on first runs; both pass in
isolation and the full suite passes clean on re-run — CI's `retries: 2`
exists for exactly this. The flakes pre-date both fix campaigns.
