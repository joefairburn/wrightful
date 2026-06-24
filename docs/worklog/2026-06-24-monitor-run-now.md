# 2026-06-24 — Monitors: "Run now" (on-demand execution of a saved monitor)

## What changed

Implemented **"Run now"** for synthetic monitors — an owner can fire one immediate
execution of an already-saved monitor from its detail page, without disturbing
the schedule. This is **Option A** from the design discussion: a "run now" on a
_persisted_ monitor (not the harder "dry-run unsaved source before saving",
which fights the IDs-only `MonitorJob` contract).

The whole execution machinery already existed for the scheduler — a "run now" is
just **one iteration of the scheduler's per-monitor work, triggered on demand**:
mint a `queued` execution row, enqueue the IDs-only job, let the existing queue
consumer + executor + `recordExecutionResult` settle it. Almost nothing new was
built; the work was an adapter around `sweepDueMonitors` plus the button + action
wiring.

It also retires the hard-disabled **"Run once"** placeholder that used to sit in
the browser create/edit form (the button whose "why is this disabled?" started
this). Running a monitor needs a persisted row, so the real action lives on the
detail page, not the create form.

## Details

| Area                   | Change                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared enqueue routing | New `src/lib/monitors/enqueue.ts` → `enqueueMonitorJob(job, monitor)`: routes `http`/`tcp`/`ping` → `queues.uptime`, browser → `queues.monitors`. Extracted from the cron's inline block so the cron and the new action share ONE source of the routing (can't drift). |
| Scheduler cron         | `crons/sweep-monitors.ts` now passes `enqueue: enqueueMonitorJob` instead of an inline routing closure; dropped its `void/queues` import.                                                                                                                              |
| Repo                   | `src/lib/monitors/monitors-repo.ts`: added `inFlightExecutionWhere(scope, monitorId)` (pure predicate) + `enqueueManualExecution(scope, monitor, now)`.                                                                                                                |
| Action                 | `monitors/[monitorId]/index.server.ts`: added `runMonitorOnce` (owner-only); added `runNotice` to the detail loader.                                                                                                                                                   |
| Detail page            | `monitors/[monitorId]/index.tsx`: added a "Run now" button to the owner action cluster (disabled while a run is in flight) + a page-level `info` Alert for the "already running" notice.                                                                               |
| Form                   | `monitors/monitor-form.tsx`: removed the dead hard-disabled "Run once" placeholder + its now-unused `Play` import; updated the layout docstring.                                                                                                                       |
| Test                   | `src/lib/monitors/__tests__/monitors-repo.workers.test.ts`: pins `inFlightExecutionWhere`'s predicate shape (tenant `projectId` + `monitorId` + `state IN ('queued','running')`).                                                                                      |

## Design decisions

- **No `nextRunAt` advance.** `enqueueManualExecution` deliberately never touches
  the monitor's `nextRunAt` — a manual run is out-of-band; the next scheduled
  tick must fire exactly when it would have. This also means a **paused** monitor
  can be test-run without resuming its schedule (the button is shown regardless
  of `enabled`).

- **In-flight guard, reusing the scheduler's rule.** `enqueueManualExecution`
  returns `null` (→ a `?runNotice=` redirect) when a `queued`/`running` execution
  already exists for the monitor — the manual twin of `dueMonitorsWhere`'s
  `NOT EXISTS` arm, so a slow monitor can't stack a second container per click.
  The detail-page button mirrors this client-side (disabled when any loaded
  execution is non-terminal).

- **Bounded double-submit race (documented, accepted).** The guard SELECT and the
  INSERT are two statements, not one atomic `INSERT … WHERE NOT EXISTS`, so two
  near-simultaneous clicks could both pass the guard → two distinct executions →
  two containers → two runs. That cost is bounded (one extra execution + its run;
  no shared row to corrupt) and self-heals. (The idempotency-keyed run-linking
  does _not_ collapse these into one run — its key is the execution's own id, so
  it only dedups redeliveries of a single execution, not two distinct ones.) Kept
  it in the Drizzle query builder rather than introduce the codebase's only
  hand-written raw `INSERT` (the pg dialect / camelCase-identifier traps the
  worklog history warns about).

- **Insert-before-enqueue ordering** matches `sweepDueMonitors`: the `queued` row
  is persisted before the queue send, so a dropped send leaves a visibly-queued
  execution the stale-execution reaper (`sweepStaleExecutions`) finalizes, not a
  silent no-op.

## Realtime note (intentional limitation)

The monitor **list** page settles executions live (it subscribes to the project
room via `useProjectRoom`; the queue consumer broadcasts on settle regardless of
how the execution was created). The **detail** page is fully server-rendered with
no client island, so after "Run now" the redirect shows the new execution as
`queued` at the top of the timeline, but it does **not** live-update as it settles
— the user reloads (or the next loader fetch) to see the terminal state. This
matches the detail page's existing behaviour and was not expanded here (no
detail-page realtime island exists today).

## Verification

- `apps/dashboard`: `vp test run -c vitest.workers.config.ts src/lib/monitors/__tests__/` → **11 files, 96 tests pass** (incl. the new `monitors-repo.workers.test.ts`); node-lane `alerts.test.tsx` → 17 pass.
- `vp lint` → exit 0 (only pre-existing `no-unsafe-type-assertion` warnings in unrelated files; none in changed files).
- `tsgo --noEmit` → exit 0 (clean).
- `vp fmt` clean on all changed files. (One unrelated pre-existing untracked worklog, `2026-06-24-members-role-select-autosave.md`, still has a formatter diff — left untouched as out of scope.)
- Not manually exercised in a running app (the user runs the dev server); the path reuses the existing, test-covered scheduler→queue→executor pipeline end-to-end.
