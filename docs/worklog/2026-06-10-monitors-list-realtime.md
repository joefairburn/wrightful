# 2026-06-10 — Realtime monitors list (reuse the project room)

## What changed

The **monitors list** now updates live: when a monitor execution settles, that
monitor's row advances its status badge, last-run time, and history strip
(`ExecStrip`) + uptime without a reload — the same "watch it happen" feel the
runs list and run-detail already have.

The key decision was **reuse, not add**: monitor events ride the existing
per-project `void/ws` room (`project:<projectId>`) as a new feed variant, rather
than a new Durable Object or a `monitor:<id>` topic. So there's **no new room, no
new DO binding, and no change to `authorizeTopicSubscription`** — monitors-list
viewers are already project members. The runs list and monitors list share one
socket per tab (ref-counted by `useRoom`); each folds only its own events.

(Synthetic monitor _runs_ already broadcast through ingest, so the runs list +
run-detail were already live for them. This fills the remaining gap: the
monitor-centric rows, written by the queue consumer — a path that didn't
broadcast.)

## How it flows

```
queue consumer (queues/monitors.ts)
  → runMonitorJob (pure, DI'd)  — records the settle, then deps.broadcast(...)
  → broadcastProjectRoom(projectId, { type: "monitor-result", ... })   [DO→DO POST]
  → project room DO broadcasts to subscribers
  → monitors-list island  → applyMonitorFeedEvent  → row advances
```

The broadcast is an **injected effect** on `runMonitorJob`, wired to
`broadcastProjectRoom` in the queue adapter — keeping the established monitors
pure/runtime split (the decision logic stays harness-testable; the runtime
publish lives in the adapter, like `executor`/`recordResult`). It fires only on
a settle that has a live row to update (skipped for missing-execution /
lost-claim / deleted-monitor). A broadcast failure can **never** flip the job's
ack/retry outcome — `safeBroadcast` swallows, and the result is already in D1.

## Details

| File                                        | Change                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/realtime/events.ts`                    | New `MonitorExecutionRow` + a `monitor-result` variant on `ProjectFeedEvent`, plus the matching member in `projectRoomServerSchema`.                                                                                                                                                       |
| `src/lib/monitors/executor.ts`              | `RunMonitorJobDeps.broadcast` injected; builds + emits the `monitor-result` event after each settle (success + infra-error paths), guarded by `safeBroadcast`.                                                                                                                             |
| `apps/dashboard/queues/monitors.ts`         | Wires `broadcast: broadcastProjectRoom` into the consumer's deps.                                                                                                                                                                                                                          |
| `pages/…/monitors/monitor-feed.ts`          | **New** pure reducer `applyMonitorFeedEvent` — the monitors-list twin of `applyProjectFeedEvent`. Co-located with the page so it's concrete over the loader row type (no generics) and imports the shared uptime helper cleanly; `import type` of the server props keeps it `void/*`-free. |
| `pages/…/monitors/monitors-list.client.tsx` | Subscribes via `useRoom("/ws/project/:projectId", …)`, folds events through the reducer over `useSeededState`, and reconnect-refreshes (no replay) — mirroring `useProjectRoom`. The pause toggle reuses the seeded setter.                                                                |
| `pages/…/monitors/index.server.ts`          | Exposes `project.id` (room key) and adds `id` to the per-row execution projection (dedupe key + React key).                                                                                                                                                                                |
| `pages/…/monitors/monitors-ui.shared.ts`    | `RECENT_EXECUTION_WINDOW` moved here so the loader (fetch window) and reducer (trim cap) share one constant.                                                                                                                                                                               |
| `pages/…/monitors/index.tsx`                | Passes `projectId` to the island.                                                                                                                                                                                                                                                          |

## Design notes / tradeoffs

- **One per-project room, not per-monitor.** Monitors fire at most once a minute
  with tiny payloads — no firehose — so the project room absorbs all of it. A
  monitor-detail viewer (a later step) would filter the project feed by
  `monitorId`; only if a project ever had hundreds of fast monitors would a
  per-`monitor:<id>` room (mirroring the per-run room) pay off.
- **Reducer is idempotent per execution id, but honors corrections.** An `error`
  execution can be re-claimed + re-run (the repo's claim contract), so the same
  execution id can broadcast twice. A repeat with the SAME state is a no-op (no
  double-count, same array reference so React bails out); a repeat that CORRECTED
  the outcome (infra `error` → `pass`) updates the existing strip entry in place,
  so a real recovery isn't stranded showing the stale failure until reload. (An
  earlier draft dropped any repeat by id outright — caught in self-review, since
  that left a recovered monitor red until the next load.)
- **List only, this pass.** The monitor _detail_ page (the execution timeline) is
  still server-rendered — making it live "like the run tests" means extracting an
  island + per-execution merge, a deliberate follow-up.
- **`running` not broadcast.** `recordExecutionResult` is the only writer of the
  monitor's denormalized `lastStatus` (terminal only); `claimExecution`→running
  doesn't touch it, so the list's display status never shows "running" — a settle
  broadcast is sufficient and matches existing semantics.

## Verification

- Dashboard vitest: **787 passed** (incl. new `monitor-feed.test.ts` — reducer
  merge/no-op-duplicate/correct-in-place/trim/ignore-run-events + schema
  accept/reject — and extended `executor.test.ts` — broadcasts on settle, error
  settle still broadcasts + retries, no broadcast when no live row, and a
  broadcast failure never changes the ack decision).
- `vp check` (fmt + lint + type): **0 errors** (70 pre-existing warnings, none in
  changed files).
- **Live**, against the running dev server: triggered the sweep cron; the queue
  consumer ran the due monitors through the new `recordResult`→`broadcast` path
  with no consumer throw, producing 3 executions (Pricing's `FORCE_FAIL` → `fail`,
  others → `pass`). The publish path is the exact DO→DO seam ingest already uses
  from this same consumer context.
- Not verified here: the WS frame landing in a browser tab (needs a live client);
  covered by the publish-path reuse + the reducer/schema unit tests.

## Follow-ups (designed-for, not built)

Monitor **detail** timeline live (island + per-execution merge, filtered by
`monitorId`); a `monitor-created`/`monitor-deleted` feed event so new/removed
monitors appear without a reconnect refresh; per-`monitor:<id>` room only if
fan-out ever warrants it.
