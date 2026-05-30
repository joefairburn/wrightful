# 2026-05-30 — Reporter internals: artifact correlate→PUT, retry policy, done-buffer

Cluster: **reporter-internals** (commit type `refactor`). Findings F30, F31, F32.
Three behaviours that were smeared across `WrightfulReporter` instance methods
and the stream client are pulled out into small, directly unit-testable seams,
following the same deep-module pattern as the dashboard's `ingest.ts` /
`artifacts.ts` work. The reporter's lifecycle code (`index.ts`) now delegates
rather than re-deriving these invariants inline.

## What changed

- **`packages/reporter/src/artifact-uploader.ts` (new) — the artifact
  register→correlate→PUT pipeline (F30).** The two private `WrightfulReporter`
  methods `fireArtifactUploads` + `uploadArtifactBatch` (previously
  `index.ts:393–471`) carried the load-bearing **positional-alignment
  invariant**: `registrations[i]` describes the same artifact whose local bytes
  live at `locals[i]`, because `registerArtifacts` returns its `uploads[]` in
  submission order and the PUT phase correlates each presigned URL back to its
  local file by index `i`. Breaking that invariant silently uploads files to the
  wrong R2 key, yet it was only reachable by replaying the reporter lifecycle
  against a stubbed fetch. It is now:
  - `correlateUploads(batch, mapping)` — pure, order-preserving; drops
    no-artifact entries and clientKey-misses from **both** arrays in lockstep so
    alignment holds.
  - `runWithConcurrency(length, concurrency, task)` — the bounded-parallelism
    worker pool lifted out of the inline `next++` loop.
  - `ArtifactUploader` — owns `upload(runId, batch, mapping)` returning
    `{ ok, failed }` counts, depending only on the `registerArtifacts` /
    `uploadArtifact` leaf primitives of the stream client (a `Pick<>`), so it is
    exercisable with a hand-rolled stub. Recoverable failures route through an
    injected `onWarn`.

  `index.ts#fireArtifactUploads` is now a thin delegate: it maps the
  `EnqueuedTest[]` batch to `ArtifactBatchEntry[]`, calls `uploader.upload(...)`,
  and folds the returned counts into `artifactsOk` / `artifactsFailed`. The
  promise is still tracked on `artifactTasks` (not awaited) so uploads overlap
  with later flushes and `onEnd` awaits them before `/complete`.

- **`packages/reporter/src/client.ts` — one shared retry policy (F31).** The
  retry/backoff rule (retry 5xx + 429 and network throws, honour `Retry-After`,
  else exponential `2^attempt * 500`ms) was written twice — once in
  `fetchWithRetry` (serving the four JSON API methods) and once hand-rolled
  inside `uploadArtifact`. Consolidated into:
  - `isRetryableStatus(status)` — pure decide half (5xx/429 retryable, all other
    4xx/2xx/3xx terminal).
  - `backoffDelay(response, attempt)` — pure wait half (`Retry-After` seconds
    win, else exponential).
  - `withRetry(attempt, policy)` — owns the loop, retryable-status check,
    `Retry-After` parse, and backoff; the caller supplies a per-attempt
    `attempt()` factory. `fetchWithRetry` now just supplies the
    `fetch` + per-attempt `AbortSignal.timeout`; `uploadArtifact` supplies the
    body re-open (a consumed stream can't be replayed) and throws its terminal
    HTTP error **outside** `attempt()` so it can't be caught and retried.

- **`packages/reporter/src/accumulator.ts` (new) — the buffer-until-final-retry
  state (F32).** The `Map<test.id, { test, results }>` with its
  get-or-create / push / done-gate / delete in `onTestEnd`, plus the `onEnd`
  fallback drain + clear, was smeared across the `WrightfulReporter` instance and
  testable only end-to-end. Concentrated into `TestAccumulator` with
  `record(test, result)` (returns the completed `{ test, results }` entry and
  removes it from pending once the test reaches its final outcome, else
  `undefined`) and `drainPending()` (yields still-buffered never-done entries and
  clears the map). The `isTestDone` gate and the `PendingTest` shape moved here;
  `index.ts` re-exports both so existing import sites (tests, downstream) stay
  stable.

## Details

| Finding | Outcome     | Essence                                                                                                                                                  |
| ------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F30     | implemented | New `artifact-uploader.ts` seam: pure `correlateUploads` (the positional invariant) + `runWithConcurrency` + `ArtifactUploader`; `index.ts` delegates.   |
| F31     | implemented | New shared `withRetry` + pure `isRetryableStatus` / `backoffDelay` in `client.ts`; both `fetchWithRetry` and `uploadArtifact` consume the single policy. |
| F32     | implemented | New `accumulator.ts` `TestAccumulator` owning record/done-gate/drain; `index.ts` holds one `accumulator` field instead of an inline `pending` map.       |

No schema, migration, or env changes — this cluster is entirely reporter-internal
refactoring with behaviour preserved.

### Tests (new / extended)

- `packages/reporter/src/__tests__/artifact-uploader.test.ts` (new) —
  `correlateUploads` (multi-entry `registrations[i]`⇄`locals[i]` alignment,
  full field carry-over, clientKey-miss drop in lockstep, no-artifact skip, empty
  batch), `runWithConcurrency` (covers all indices, never exceeds the bound,
  no-op for non-positive length), and `ArtifactUploader.upload` (positional PUT
  pairing, whole-batch-failed + warn on register throw, per-file failure count +
  warn, no register when nothing to correlate, configured concurrency limit).
- `packages/reporter/src/__tests__/accumulator.test.ts` (new) — `record`
  (single pass → done, two fails then a pass → one aggregated entry removed from
  pending, exhausted-retry final failure → done, independent keying by `test.id`)
  and `drainPending` (yields never-done entries + clears, empty when all
  completed).
- `packages/reporter/src/__tests__/client.test.ts` (extended) — direct unit
  tests for `isRetryableStatus` (5xx, 429, terminal 4xx, 2xx/3xx) and
  `backoffDelay` (exponential curve, network-throw null-response fallback,
  `Retry-After` precedence).

## Verification

All four gates green:

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (`void prepare` +
  `tsgo --noEmit`, 0 errors).
- `pnpm --filter @wrightful/dashboard test` — 509 passed (42 files).
- `pnpm --filter @wrightful/reporter test` — 176 passed (13 files), up from the
  ~136 baseline as the new seams added direct unit coverage.
- `pnpm check` — 0 errors, 78 warnings (pre-existing `no-unsafe-type-assertion`
  in `client.ts` / `pr-comment.ts` / `auth.ts`).

The reporter's own `typecheck` script (`tsgo --noEmit`) exits 0; the
`tsc -p tsconfig.json` cross-package `rootDir` errors from `contract.test.ts`
(which imports the dashboard's Zod schemas) are pre-existing and not introduced
by this cluster.

### Integration gap (noted, not closed)

`ArtifactUploader` is tested against a hand-rolled stub of the two stream-client
leaf primitives, and `withRetry` is verified through its pure halves
(`isRetryableStatus` / `backoffDelay`) — the live `fetch` + R2 PUT round-trip
remains covered only by the e2e dogfood suite. `TestAccumulator` is fully pure
and unit-tested directly.
