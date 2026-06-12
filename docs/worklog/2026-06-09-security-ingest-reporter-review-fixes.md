# 2026-06-09 — Security, ingest, and reporter review fixes (full-review remediation, part 1 of 3)

## What changed

A full-codebase review (five parallel audit passes: tenant isolation/authz,
ingest + API auth + artifacts, the reporter package, monitors/realtime, and
frontend/data-layer quality) surfaced ~40 findings. This entry covers the
security/ingest/dashboard-core batch and the `@wrightful/reporter` batch; the
sibling entries cover the rest of the same campaign:

- `2026-06-09-monitor-queue-realtime-review-fixes.md` — monitors, queue, WS.
- `2026-06-09-dashboard-frontend-review-fixes.md` — frontend/realtime hooks,
  pills, loaders, dead code, lib tests.

No schema changes; no migration. One new Cloudflare rate-limiter binding.

## Dashboard: ingest correctness

### Unchunked `inArray` hard-failed large /results batches (`src/lib/ingest.ts`)

`resolveTestResultIds` put every `testId` of a batch into ONE `inArray`
statement. D1 caps bound params at 100, the contract advertises
`MAX_RESULTS_PER_BATCH = 5000`, and `batchSize` is a public reporter option —
any batch with ≳97 unique testIds was a guaranteed 500 (retried 3× by the
reporter into the same wall, then dropped). Now chunked via `chunkBySize` at
`MAX_PARAMS_PER_STATEMENT - 2` (projectId + runId take two params), mirroring
the pattern `registerArtifacts` already used.

### `openRun` / `registerArtifacts` lost-the-race 500s (`ingest.ts`, `artifacts.ts`)

Both used SELECT-then-INSERT idempotency. Sharded suites share one
idempotencyKey and open concurrently BY DESIGN, so the loser's insert hit the
unique index and bubbled an uncaught 500 (self-healing only because the
reporter retries 5xx). `openRun` now catches the unique violation
(`isUniqueViolation`, new in `src/lib/db-batch.ts` — the single home for D1's
"UNIQUE constraint failed" substring detection) and re-reads the winner's row;
`registerArtifacts` re-runs its whole flow once so the loser adopts the
winner's rows through the existing idempotency path.

### Duplicate `testId` within one payload PK-crashed the batch (`ingest.ts`)

Two entries sharing one NEW testId shared one assigned ULID → multi-row insert
hit the testResults PK → whole batch 500. New `dedupeResultsByTestId`
(last-write-wins, first-occurrence order) makes the batch total. Unit-tested.

### Results accepted forever after /complete (`ingest.ts`, results route)

`appendRunResults` had no terminal-status guard, so a compromised key could
silently rewrite months-old runs. Straggler tolerance is intentional (sharded
suites flush while a sibling's /complete lands), so the bound is a grace
window: `runClosedForResults` refuses appends when the run is terminal AND
`completedAt` is older than `RESULTS_AFTER_COMPLETE_GRACE_SECONDS` (30 min,
matching the stale-run watchdog). The route maps it to 409 (4xx → the reporter
drops the batch instead of retrying). Unit-tested.

## Dashboard: security & abuse

### Closed instances: team creation is now the enforcement point (`src/lib/provisioning.ts`, `auth.ts` untouched)

The review flagged that GitHub OAuth bypasses `ALLOW_OPEN_SIGNUP`. Hard-closing
OAuth signup would break invite onboarding entirely — invites don't create
accounts, so OAuth is the only way an invited newcomer can register on a closed
instance. The fix enforces "closed" at the first resource-granting action
instead: `createTeamForUser` now consults `teamCreationAllowed` —
open-signup instances allow anyone; closed instances allow existing members of
any team plus the zero-teams bootstrap case. A self-registered stranger on a
closed instance holds a dead account: no team → no projects, keys, or
synthetic monitors (which execute arbitrary code in containers on the
operator's Cloudflare account). New `TeamCreationNotAllowedError` mapped to 403
(JSON route) / `?error=` (form action). Documented in SELF-HOSTING.md
("What \"closed signup\" actually closes"). Pure policy unit-tested.

### Directed invites no longer match unverified emails (`src/lib/auth-users.ts`)

`getUserIdentity` read `user.email` with no `emailVerified` check; with signup
open, anyone could register `victim@corp.com` (no verification email exists)
and see/redeem the victim's directed invites. The identity now carries the
email only when `emailVerified` is truthy. GitHub OAuth users get
`emailVerified` from GitHub's verified-email flag (checked in better-auth
1.6.11's github provider), so the OAuth invite flow keeps matching; unverified
password accounts fall back to the GitHub-login channel or undirected token
links, and regain email matching automatically when verification ships.

### Failed-auth ingest requests bypassed rate limiting (`middleware/02.api-auth.ts`, `wrangler.jsonc`)

02 returned the 401 before `next()`, so 03's per-key limiter never ran for bad
keys — an unthrottled D1-lookup amplification surface. New pre-auth IP
backstop: `INGEST_IP_RATE_LIMITER` (600/min/IP — deliberately 5× the per-key
budget so NAT'd CI fleets never trip it) checked at the top of 02's ingest
branch, before the Bearer lookup. `rate-limit-config.test.ts` extended (the
binding↔wrangler bijection now spans both gate middlewares); behavior pinned
in `rate-limit.test.ts` (429 before auth — proven by the guarded db stub not
throwing).

### Member removal + leave team (`pages/settings/teams/[teamSlug]/members.*`)

There was NO revocation path — once joined, access was permanent short of
deleting the team. Added `removeMember` (owner-only; self-removal blocked,
which also makes stranding the team ownerless impossible — the acting owner
always survives) and `leaveTeam` (any role; the last owner is refused and told
to delete the team). UI: per-row Remove for owners, a Leave-team card, and a
`membersError` alert via the existing `redirectWithParam` convention.

### R2 bytes deleted with the tenant (`src/lib/artifacts.ts`, both delete actions)

Team/project deletion cascaded D1 rows but nothing ever called
`storage.delete` — "permanently deleted" teams kept traces/screenshots/videos
(which can embed secrets) in R2 forever. New `deleteProjectArtifactObjects`
sweeps `t/<teamId>/p/<projectId>/` (list+bulk-delete pages of 1000, bounded at
100 pages/call with a logged leftover warning), called best-effort AFTER the
authoritative row deletion by `deleteProject` and `deleteTeam` (per project).
Failures log and never resurrect the user-facing action.

### Smaller hardening

- `keys.server.ts` loader selected `*` — every key's `keyHash` shipped in
  client-visible page props. Explicit column list now.
- `storeArtifactUpload` echoed raw R2 exception text in the 502 body; now
  logs it via `void/log` and returns a generic message (pinned by test).
- Test-detail child queries (`tags`/`annotations`/`artifacts`/`attempts`)
  re-carry the `projectId` predicate per the project invariant (was safe via
  the parent probe, but one refactor away from not being).
- `run-duration.server.ts` raw SQL now binds the branded `scope.projectId`
  instead of `project.id`.

## Dashboard: synthetic traffic separation (`runs.origin` was write-only)

Nothing filtered by `origin`, so a 1-minute monitor would have intermixed
1,440 runs/day into the runs list, live feed, and analytics:

- **Runs list** — `RunsFilters` gains `origin: "ci" | "synthetic" | "all"`
  (default `ci` = exclude synthetic); clause in `buildRunsWhere`; a
  `SegmentedControl` (CI / Monitors / All) in the filter bar; round-trips via
  `?origin=`.
- **Analytics** — `testResultsScopeJoin` bakes `runs.origin <> 'synthetic'`
  into its ON clause, so every surface routing through it (tests catalog,
  flaky, insights) inherits the exclusion; `run-duration.server.ts` (which
  queries `runs` directly) excludes inline. Known accepted edge: flaky's
  sparkline pass skips the runs join when no branch filter is active — its
  testIds come from the already-excluded main pass, and monitor-check testIds
  (different file) can't collide with CI testIds in practice.
- **Live feed** — synthetic runs are suppressed at PUBLISH time for the
  project room (`run-created` + `run-progress` in `openRun` /
  `appendRunResults`; `suppressProjectFeed` option on
  `reconcileAndBroadcast` for `completeRun` / `finalizeStaleRun`). Run-room
  broadcasts are untouched (monitor pages may watch a run directly).

## Dashboard: search was broken for `%`/`_`/`\` (`runs-filters-where.ts`, `analytics/filters.ts`)

`escapeLike` backslash-escaped LIKE metacharacters but Drizzle's `like()`
emits no `ESCAPE` clause — and SQLite defines NO default escape character, so
`\%` matched a literal backslash and searches like "100%" returned nothing.
New `likeEscaped(column, pattern)` emits `LIKE ? ESCAPE '\'`; the analytics
`searchFragment` (which previously didn't escape at all — wildcards leaked
into the tests/slowest-tests search) now uses `escapeLike` + `ESCAPE` too, so
both search surfaces share literal-match semantics. Tests now pin the SQL text
(the previously-untested layer where the bug lived), not just the string
transform.

## Reporter (`@wrightful/reporter`) — robustness as a guest in the user's CI

- **`Retry-After` clamped** (`client.ts`): was honored verbatim (a
  misbehaving proxy could sleep CI for hours; HTTP-date form parsed to NaN →
  `setTimeout(NaN)` → zero backoff). Now: invalid/negative → exponential;
  everything clamped to `MAX_BACKOFF_MS = 30s`.
- **No more unhandled rejections from artifact tasks** (`index.ts`):
  `trackTask()` wraps every pushed promise (catch → warn → counted);
  `enqueueDone` swallows internally. A poisoned attachment can no longer kill
  the user's suite or skip drain/complete.
- **Aggregate onEnd deadline**: new `shutdownTimeoutMs` option (default 10
  min) bounds the whole drain, reserving ~30s for `/complete`; on expiry it
  abandons in-flight uploads with a warning and still completes the run.
- **Mid-run `AuthError` disables the client** (matching openRun) instead of
  re-sending every batch with the bad token.
- **Idempotency key discriminators** (`ci.ts`): `GITHUB_RUN_ID` is
  workflow-level, so matrix jobs / parallel jobs / `--shard` runs silently
  merged into one dashboard run. CI-derived keys now append the job name
  (`GITHUB_JOB`/`CI_JOB_NAME`/`CIRCLE_JOB`) and Playwright shard
  (`config.shard`), capped at the schema's id length;
  `WRIGHTFUL_IDEMPOTENCY_KEY` stays verbatim (synthetic monitors depend on
  it). Re-run determinism preserved.
- **One bad attachment no longer poisons the register batch**: content types
  are normalized client-side against a mirror of the dashboard's
  `SAFE_CONTENT_TYPES` (contract-tested for exact equality), `snapshotName`
  truncates to the schema max, and a 413 response drops the oversize
  offenders (warn each) and retries the register exactly once.
- **Quality-of-life**: `postPrComment` gate reasons surface as a warning;
  outside-allowed-root artifact drops warn once per run; `collectArtifacts`
  awaits only the root-resolution promise (was the whole task graph — O(n²));
  upload concurrency cap is now global across batches (instance-level
  `Semaphore`); `--repeat-each` instances get distinct testIds
  (`repeatEachIndex` folded into the hash only when > 0, so existing ids are
  byte-stable); PR detection falls back to `GITHUB_EVENT_PATH` JSON for
  `pull_request_target`-style events.

## Review findings deliberately NOT fixed (recorded)

- **Role changes (owner ⇄ member)** — remove + leave shipped; promotion needs
  product thought (invites only mint members today).
- **`monitorExecutions` infra-error flag** — a settled real `error` outcome is
  still re-claimable by a duplicate queue redelivery; the clean fix is a
  persisted flag (schema change). Docstring on `claimExecution` now states the
  exact invariant. (See monitors worklog.)
- **e2e coverage gaps** the audit listed (member-role denial, cross-tenant WS
  connects, directed-invite misuse, artifact-token tampering) — test backlog,
  not product fixes; unit coverage was added where the fixed logic is pure.
- **`apiKeys` label-LIKE sweep is unindexed** — fine at current scale; noted.

## Verification

| Check                                             | Result                                       |
| ------------------------------------------------- | -------------------------------------------- |
| `pnpm check` (oxfmt + oxlint + type-aware)        | exit 0 — 0 errors (64 pre-existing warnings) |
| `tsgo --noEmit` (dashboard, after `void prepare`) | clean                                        |
| Dashboard unit tests (`vp test run`)              | 73 files, 755/755 passed                     |
| Reporter unit tests                               | 14 files, 231/231 passed (+33 new)           |
| Dashboard build (`vp build`)                      | pass                                         |
| Reporter build (`vp pack`)                        | pass                                         |
| API e2e (`pnpm test:e2e`, boots dashboard)        | 12/12 passed                                 |
| Dashboard UI e2e (`test:dashboard`)               | 37 passed, 1 skipped (visual baseline gate)  |

The UI e2e suite showed two parallel-worker timing flakes on the first pass
(monitors cycle, test-detail navigation); both pass in isolation and the full
suite passed clean on re-run — the same flake class CI's `retries: 2` exists
to absorb.

Note for future agents: the dashboard's vitest runs via
`pnpm --filter @wrightful/dashboard exec vp test run <files>` — the
`exec vitest run` form documented in CLAUDE.md fails with "vitest not found".
