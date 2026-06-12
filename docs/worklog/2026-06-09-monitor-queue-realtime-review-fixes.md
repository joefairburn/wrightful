# 2026-06-09 — Synthetic-monitoring + realtime review fixes (queue backoff, timeout classification, overlap suppression, reaper clocks, WS origin gate)

## What changed

Nine verified review findings against the synthetic-monitoring pipeline
(`queues/monitors.ts`, `src/lib/monitors/**`, `crons/*`) and the realtime
infrastructure (`src/realtime/room-server.ts`, `routes/ws/*`) were fixed in
place. No schema changes.

### 1. Queue retry backoff + batch size (`queues/monitors.ts`)

- `maxBatchSize` 5 → **1**: jobs run serially and each can hold a container for
  `WRIGHTFUL_MONITOR_MAX_DURATION_SECONDS` (5 min default), so a full batch of 5
  could exceed the queue consumer's 15-minute invocation bound.
- New exported `retryDelay = 30` (consumer-level default) and both
  `message.retry()` call sites now pass `{ delaySeconds: retryDelay }`. With the
  platform default of 0, a `SandboxLimitError` redelivery landed milliseconds
  later against the same exhausted budget and burned all `maxRetries` within
  seconds, dead-lettering jobs a moment of breathing room would have saved.

### 2. Per-test timeout vs exec wall-clock (`sandbox-executor.ts`, `playwright-config.ts`)

Previously `PLAYWRIGHT_TIMEOUT_MS == exec timeout == maxDurationMs`, so a
hanging user test consumed the whole budget, the exec kill also killed teardown
and the reporter's `/complete` POST, and a _deterministic_ user-script hang was
misclassified `infraError: true` → up to 3 full container re-runs.

- New pure `perTestTimeoutMs(maxDurationMs)` in `playwright-config.ts`:
  `max(30_000, maxDurationMs - 30_000)` (exported headroom/floor constants).
- The executor classifies an exec failure **at or past the budget** (the SDK's
  timeout-kill error shape is not part of its public contract, so elapsed time
  is the classifier) as a TERMINAL user-facing outcome: `state: "error"`,
  `infraError: false`, clear message, linking the partial run id when one was
  streamed. A run that still reached a terminal status despite the kill falls
  through to the normal status mapping. Pre-budget throws remain infra errors.

### 3. Overlap suppression (`scheduler.ts`)

The sweep SELECT planned purely off `nextRunAt`; a 60s-interval monitor with
300s checks stacked up to 5 concurrent containers forever. New exported pure
`dueMonitorsWhere(now)` adds a `NOT EXISTS` arm (one round trip): a monitor
with an execution still `queued`/`running` is invisible to the sweep.
**Chosen behavior: skipped monitors do NOT advance `nextRunAt`** — the past-due
value keeps them due, so the tick after the in-flight execution settles picks
them straight back up. No permanent starvation: the stale-execution reaper
bounds how long any execution stays non-terminal.

### 4. Reaper clocks (`monitors-repo.ts`, `synthetic-key.ts`, `crons/sweep-synthetic-keys.ts`)

- `sweepStaleExecutions` now ages `running` rows from
  `coalesce(startedAt, createdAt)` (new exported pure `staleExecutionsWhere`).
  Queue dwell before the claim is unbounded, so aging from `createdAt` reaped an
  execution claimed at minute 29 of a 30-minute window mid-flight. `queued`
  still ages from `createdAt`. The per-row UPDATE guard re-applies the same
  predicate, so a row claimed between the SELECT and the write isn't clobbered.
- `sweepStaleSyntheticKeys` now excludes keys whose owning execution is still
  `queued`/`running` (new exported pure `orphanedSyntheticKeysWhere`, a
  `NOT EXISTS` joining `monitorExecutions.id = substr(label, prefix+1)`).
  Chosen over a cutoff extension because age alone races the execution
  lifecycle regardless of how the env windows are tuned.

### 5. `claimExecution` re-claim invariant (`monitors-repo.ts`) — docstring path

The executions table persists no infra-vs-real error distinction, so the
minimal no-schema fix does not exist. The docstring now states the precise
invariant (`pass`/`fail`/`degraded` immutable; `error` re-claimable by ANY
redelivery, including a duplicate after a settled real error — a bounded,
converging cost, not corruption) and notes that closing it requires persisting
an infra-error flag (schema change, deliberately not taken).

### 6. Dead env knob removed

`WRIGHTFUL_MONITOR_MIN_INTERVAL_SECONDS` deleted from `env.ts` (it was
referenced only in comments; the real floor is `MONITOR_INTERVAL_PRESETS`).
Stale comments in `crons/sweep-monitors.ts` and `monitor-schemas.ts` fixed.

### 7. Stale secret-fallback comments

`room-server.ts` and `vite.config.ts` claimed a `BETTER_AUTH_SECRET` fallback
that `resolveInternalSecret` deliberately does not implement (it throws). Both
comments now describe the real behavior.

### 8. WS Origin validation (defense in depth)

New pure `isAllowedWsOrigin(origin, publicUrl)` in `room-server.ts`; both room
routes (`routes/ws/run/[runId].ws.ts`, `routes/ws/project/[projectId].ws.ts`)
reject (403) a present `Origin` header that doesn't match
`WRIGHTFUL_PUBLIC_URL`'s origin, before the capacity/authz checks. Absent
header allowed (non-browser clients); malformed header or public URL rejects
(including the literal `Origin: null` opaque origin).

### 9. SELF-HOSTING.md

New "Production notes" section: pin `REALTIME_INTERNAL_SECRET` in production
(per-build random default briefly drops cross-version realtime broadcasts
during rolling deploys — logged 403, non-fatal), and the rate limiter's
`X-Forwarded-For` fallback is client-spoofable when not fronted by Cloudflare.
`REALTIME_INTERNAL_SECRET` added to the optional env list + table.

## Tests

- `scheduler.test.ts` — new `dueMonitorsWhere` describe (overlap-suppression
  predicate shape via the `void/db` stub placeholders).
- New `stale-sweeps.test.ts` — `staleExecutionsWhere` (running arm on
  `coalesce(startedAt, createdAt)`) + `orphanedSyntheticKeysWhere` (label,
  cutoff, NOT EXISTS substr join).
- `executor.test.ts` — new test pinning a wall-clock-timeout outcome
  (`infraError: false`) records + acks, never retries.
- `playwright-config.test.ts` — `perTestTimeoutMs` clamp + floor.
- `room-server.test.ts` — `isAllowedWsOrigin` matrix.
- `ws-rooms.test.ts` — both rooms 403 a cross-site Origin before authz; allow
  own origin and absent header. (Test ctx uses a bare `Headers` — happy-dom's
  `Request` applies the fetch spec's forbidden-header filtering and silently
  strips `Origin`.)

## Verification

- Targeted: `executor`, `scheduler`, `playwright-config`, `stale-sweeps`,
  `ws-rooms`, `room-server`, `publish`, `drain-stale-runs` — **8 files,
  71 tests, all passing**.
- `pnpm --filter @wrightful/dashboard run typecheck` (`void prepare` +
  `tsgo --noEmit`) — clean, repo-wide (also validates the
  `message.retry({ delaySeconds })` signature and the env key removal).
- `vp check` format stage — no issues in any file touched here (failures in
  the working tree at the time were from parallel work on other files).
