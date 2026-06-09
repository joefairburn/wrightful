# 2026-06-07 — Run-detail header fields go live + one shared WS per room

## What changed

Bug report: on the run-detail page the **status glyph kept showing "running"
after a run completed** — it only flipped on refresh. Root cause: the sticky-H1
status glyph (and the H1 duration, and the Tests-tab count) were rendered from
the **static SSR `run.*` props**, not from the live `void/ws` room summary. The
summary tiles + OutcomeBar (`<RunSummaryLive>`) and the per-test list
(`<RunProgress>`) were already live; these three header fields were not wired up.

Fixed by binding the stale fields to the live room summary, and — since the
islands convention keeps each a separate leaf (no client page-root provider to
share one subscription through) — by making `useRoom` share **one** WebSocket per
room across all leaves instead of opening one per hook.

## Changes

| Area              | File                                       | Change                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared connection | `src/realtime/use-room.ts`                 | Added a module-level ref-counted registry (`subscribeToRoom`): all hooks for the same `path\|params` share ONE socket — opened on the first subscriber, fanned out to all, closed when the last unmounts. `useRoom` now subscribes through it. |
| Live leaves       | `src/components/run-detail-live.tsx` (new) | `RunStatusGlyphLive`, `RunDurationLive`, `RunTestCountLive` — each subscribes via `useRunRoom` and reads `currentSummary(state, initialSummary)`, falling back to the SSR seed until the first event.                                          |
| Wiring            | `pages/.../runs/[runId]/index.tsx`         | Replaced the static `<StatusGlyph status={run.status}>`, the H1 duration span, and the Tests-tab `{run.totalTests}` with the live leaves. Dropped the now-unused `StatusGlyph` import.                                                         |

After this, the run-detail page holds **exactly one** WebSocket to `/ws/run/:runId`
shared by five live consumers (status glyph, duration, tab count, summary tiles,
per-test list) — realizing the "share one WS per run-detail tab" follow-up noted
in the migration worklog.

## Live vs static audit (per "check everything is wired up")

**Now live over the shared room WS:** status glyph · H1 duration · Tests-tab
count · summary tiles (passed/failed/flaky/skipped) · OutcomeBar · per-test list.

**Intentionally static** (immutable for a given run): commit message, #shortId,
"Nm ago" relative time (createdAt), the chip row (branch / PR / env / actor /
commit), and the Environment-tab metadata table.

**Known minor gaps (left static, low value):** the Environment-tab "Duration"
row and the RunHistoryChart's _current-run_ point (status/duration) still come
from SSR, so they settle on the next load. Both are secondary; wiring them would
mean threading the live summary into the env table / chart-point shape. Flagged
here rather than silently skipped.

## Follow-up: duration ticks elapsed-since-start while running

The duration on both the runs list and the run-detail header used to render the
stored `durationMs`, which **isn't wall-clock for an in-progress run** (it's 0 /
accumulated test time until `completeRun` writes the reporter's final value) — so
a running run showed a misleading near-zero duration. Replaced both with a shared
`<LiveDuration>` (`src/components/live-duration.tsx`): while `status === "running"`
(and no `completedAt`) it ticks **wall-clock elapsed since `createdAt`** every
second; the moment the WS delivers the terminal summary it switches to the
authoritative `durationMs`.

- The list row (`run-list-row.tsx`) feeds it the live row fields (the reducer
  already overlays `status` / `durationMs` / `completedAt` onto the row);
  `RunDurationLive` (run-detail) feeds it the live summary + the SSR `createdAt`
  (immutable, not carried in the summary).
- The timer starts only after mount + only while running, so the first
  (SSR/hydration) paint is the deterministic stored value — no hydration mismatch
  — and terminal runs never start an interval. The running/terminal switch is the
  pure `displayDurationMs`, unit-tested.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` → clean.
- `pnpm --filter @wrightful/dashboard test` → **626 passed / 57 files** (new:
  `use-room-sharing.test.ts` — ref-counted sharing: one socket for N subscribers +
  fan-out, close-on-last + double-unsub no-op, distinct-room isolation + reopen;
  `live-duration.test.ts` — `displayDurationMs` running-vs-terminal switch,
  pre-mount fallback, completedAt-race, negative-clamp).
- `pnpm check:fix` → 0 errors.
- `pnpm --filter @wrightful/dashboard build` (`vp build`) → succeeds.
- Live behaviour to confirm in-browser after a dev restart: start a run, watch
  the H1 glyph flip running→passed/failed on completion without a reload, and the
  duration tick up every second while running on both the list and detail pages.
