# Background-work hardening: scheduler, billing, retention, provisioning

Date: 2026-07-16
Area: crons / background work (monitor scheduler, billing reconcile, retention
sweep, team provisioning, stuck-execution claim)

Hardens the scheduled/background subsystems against overlap double-fire,
fleet-scale subrequest exhaustion + tail starvation, monitor blindness on a
dropped enqueue, and an anonymous first-team takeover. All within the
background-work file ownership; no schema changes.

## Changes

### 1. Monitor scheduler double-enqueue under overlapping sweeps (MEDIUM)

`src/lib/monitors/scheduler.ts` — `sweepDueMonitors`.

The re-arm UPDATE previously had no CAS guard (`where eq(monitors.id, id)`), so
two overlapping ticks (a long sweep spilling past the next minute, or the authed
production-trigger path racing the real cron) could both SELECT the same due
monitor and each mint an execution + container for one tick (double billing,
duplicate history). The one-batch ordering comment claimed "a double tick can't
double-fire" but that was not actually true under overlap — both ticks still
inserted an execution.

Fix — claim-then-act:

- New pure `monitorReArmCasWhere(id, now)` = `and(eq(id), eq(enabled,1),
lte(nextRunAt, now))`. The re-arm now runs FIRST as a compare-and-swap with
  `.returning({ id })`: it advances `nextRunAt` only for a monitor still enabled
  and still due at the value the sweep read. Under Postgres READ COMMITTED the
  two UPDATEs serialize on the row lock; the loser re-evaluates its `nextRunAt <=
now` arm against the already-advanced (future) value, matches zero rows, and is
  dropped.
- New pure `claimedMonitorIds(updateResults)` reduces the batch's per-statement
  `.returning()` arrays to the set of ids actually claimed.
- Executions are inserted (a SEPARATE batch) and jobs enqueued ONLY for claimed
  monitors, so an overlapping loser never gets a `queued` execution. Tradeoff: a
  claim succeeding then the insert batch failing loses one tick (monitor re-armed,
  no execution) — rare, benign, self-heals next interval, strictly preferable to
  an orphan execution.

Tests (`scheduler.workers.test.ts`): `monitorReArmCasWhere` predicate shape (id +
enabled=1 + nextRunAt<=now); `claimedMonitorIds` collects only returning-row ids
and drops zero-row/​non-array/​non-string results.

### 2. `reconcileBilling` bounded slice + rotation (MEDIUM)

`src/lib/billing/reconcile.ts`, `env.ts`.

The team SELECT had no `limit`/`order`, and the loop does one Polar
`subscriptions.list` per team serially. At fleet scale the daily cron exhausted
the Workers subrequest/CPU budget mid-loop, and because order was stable the SAME
tail of teams was never reconciled — a lost `subscription.revoked` webhook for a
tail team never self-healed.

Fix: `.orderBy(sql\`random()\`).limit(env.WRIGHTFUL_BILLING_RECONCILE_BATCH_SIZE)`(new env var, default 500). Random order rotates coverage across daily passes
(same approach as`sweepRetention`); the cap bounds one invocation. Still a clean
no-op when billing is off (early `!POLAR_ACCESS_TOKEN` return unchanged).

Tests (`src/lib/billing/__tests__/reconcile.test.ts`, new): billing-off no-op
touches neither DB nor Polar; billing-on applies `.limit(batchSize)` and a
`random()` ORDER BY.

### 4. Dropped-enqueue monitor blindness (LOW)

`src/lib/monitors/scheduler.ts` — `sweepDueMonitors`.

A failed queue send left the just-inserted execution stuck `queued`, which
suppresses the monitor via the `dueMonitorsWhere` NOT EXISTS until the 30-minute
stale reaper — blinding a 60s monitor for that whole window (green badge, no
checks, no alert).

Fix: the sweep now tracks the execution ids whose send failed and flips them to
terminal `error` (`errorMessage: "monitor enqueue failed"`) before returning,
guarded on `state = 'queued'` so a job that was actually claimed by a consumer
(send landed but promise still rejected) is never clobbered. The error execution
drops out of the NOT EXISTS, so the monitor is due again next interval; the
failed attempt stays visible in the timeline; the monitor's denormalized badge is
left untouched (owned by real recorded executions).

Note: proactive alerting on a stuck/stale monitor remains a documented v1 gap
(out of scope here).

### 5. `claimExecution` can re-run a settled real-error outcome — DEFERRED (LOW)

`src/lib/monitors/monitors-repo.ts` — `claimExecution`.

The claim CAS admits `state IN ('queued','error')` to support infra retries, but
`monitorExecutions` does not persist whether an `error` was infra (retryable) or
real (settled), so a duplicate at-least-once redelivery after a REAL error can
re-claim and re-run. Bounded/converging (one extra container; run linking keeps
the produced run singular), not corruption.

DEFERRED-PENDING-SCHEMA — the clean fix needs ONE new column that this workstream
must NOT add (schema is another owner's):

- `monitorExecutions.infraError` (integer 0/1), written by `recordExecutionResult`
  (which already computes the split — `monitorBadgeUpdate` returns null exactly
  for a retryable infra error).
- Then the claim admits `state = 'queued' OR (state = 'error' AND infraError = 1)`,
  so a duplicate after a real error finds the row outside the claimable set.

No existing column can stand in: `attempt` counts retries but not the cause;
`errorMessage` is free text. A clear code comment naming the column was added at
the CAS site. No code change to `claimExecution` behavior this pass.

### 6. First-team bootstrap grants a stranger container code-execution (LOW/MED)

`src/lib/provisioning.ts`, `env.ts`.

`teamCreationAllowed` was `openSignup || isMemberOfAnyTeam || !anyTeamExists`. On a
fresh invite-only instance (GitHub OAuth signup necessarily open — invites don't
mint users) any anonymous stranger who reached the URL first could claim the
FIRST team, become owner, and run arbitrary Playwright in containers billed to the
operator.

Fix: the zero-teams path is now gated behind an explicit operator opt-in —
`allowFirstTeamBootstrap` input, sourced from new env var
`WRIGHTFUL_BOOTSTRAP_FIRST_TEAM` (boolean, default false). The operator flips it on
for the short bootstrap window, creates the first team, flips it off. The
open-signup path (`openSignup === true`) is unchanged; existing members can still
always create more teams. The check-then-insert slug race still falls through to
the DB unique violation as before.

Tests (`provisioning-slug.workers.test.ts`): bootstrap allowed only when opted in;
REFUSED to an anonymous stranger when not opted in; open-signup + member paths
unaffected by the flag.

`SELF-HOSTING.md` and `.env.example` document the bootstrap window explicitly so
a closed fresh install does not appear locked: enable the flag, create the first
team, then disable it again.

### 7. Retention idle-probe re-cost (LOW)

`src/lib/retention.ts` — `drainRetention`.

The round-robin drain re-probed EVERY idle project (2 SELECTs) on EVERY round for
as long as any project stayed productive — O(projects × rounds). On a large fleet
with a deep backlog that blows the cron's 1000-subrequest cap and the invocation
dies mid-sweep.

Fix: a project whose sweep freed nothing is added to an in-invocation `idle` set
and never re-probed. Safe because within one invocation the retention cutoffs are
fixed and rows are only ever deleted, so a project idle now stays idle until the
invocation ends. Probe cost is now O(projects) per invocation. The existing
budget-charging (productive chunks only) and randomized project order are
unchanged.

Tests (`retention.workers.test.ts`): an idle project is probed exactly once even
across multiple productive rounds of a busy project. Existing `drainRetention`
tests still pass (idle-skip is consistent with them — idles are only skipped after
their first probe).

## Files

- `apps/dashboard/src/lib/monitors/scheduler.ts` (CAS claim, claim-then-act,
  failed-enqueue un-stranding, two new pure helpers + docstrings)
- `apps/dashboard/src/lib/monitors/monitors-repo.ts` (deferral comment naming the
  `infraError` column)
- `apps/dashboard/src/lib/billing/reconcile.ts` (random-order + limit)
- `apps/dashboard/src/lib/retention.ts` (idle-skip)
- `apps/dashboard/src/lib/provisioning.ts` (bootstrap gate)
- `apps/dashboard/env.ts` (`WRIGHTFUL_BILLING_RECONCILE_BATCH_SIZE`,
  `WRIGHTFUL_BOOTSTRAP_FIRST_TEAM`)
- `SELF-HOSTING.md`, `apps/dashboard/.env.example` (operator bootstrap guidance)
- Tests: `scheduler.workers.test.ts`, `retention.workers.test.ts`,
  `provisioning-slug.workers.test.ts`, `src/lib/billing/__tests__/reconcile.test.ts`
  (new)

## Verification

- `vitest run -c vitest.workers.config.ts scheduler.workers.test.ts
retention.workers.test.ts` — 27 passed.
- `vitest run -c vitest.workers.config.ts provisioning-slug.workers.test.ts` —
  16 passed.
- `vitest run src/lib/billing/__tests__/reconcile.test.ts` — 2 passed.
- `tsc --noEmit` on the dashboard: no new errors in any owned file (the only 2
  errors are pre-existing/​concurrent work in `flaky.server.ts`, not owned here).
- Repo-wide format/lint and the e2e/preview harness were intentionally NOT run
  (shared working tree with other agents).

## Deferred / requires schema (out of this workstream)

- Finding 5 real-error re-claim: needs `monitorExecutions.infraError` (integer
  0/1). Named above and in the code comment; NOT added here.
