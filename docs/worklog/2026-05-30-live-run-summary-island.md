# 2026-05-30 — Make the live run summary load-bearing (F19)

## What changed

The ingest pipeline builds and broadcasts a transactionally-consistent
`RunProgressEvent.summary` on every write (and it is the _entire_ payload of the
`completeRun` broadcast — `changedTests: []` + summary), `useRunProgress`
accumulated it, and then the only client consumer (`RunProgress`) destructured
it as `_summary` and threw it away. Meanwhile the run-detail header rendered the
per-status tiles + `OutcomeBar` (and the Tests-tab count) from the static SSR
`run.*` props in the RSC page component, which never re-renders on a live event.
So the seam _claimed_ the summary flowed live to the UI but it did not — only the
per-test row list updated live, and `RunProgress` re-derives its own counts from
`byId`.

We made the seam honest by wiring the published summary to the header consumers
(option (a) of the finding):

- New `<RunSummaryLive>` client island (`src/components/run-summary-live.tsx`)
  owns the per-status `SummaryStat` tiles + the `OutcomeBar`, reading
  `useRunProgress(runId).summary` (seeded by `initialSummary`). One subscription
  drives both. `"use client"` stays at this leaf, not the page root (islands
  ADR). The run-detail page now renders this island in place of the static
  SSR tiles/bar and passes `run.*` only as the seed.
- New pure helper `currentSummary(state, fallback)` in `src/lib/live-client.ts`
  concentrates the "live snapshot, else SSR fallback" coalesce so every header
  consumer shares one unit-tested rule instead of re-deriving `?? fallback`.
- `RunProgress` no longer accepts/forwards `initialSummary` and no longer
  destructures the discarded `_summary` — it owns only the per-test list and
  derives counts from its own `byId` accumulator. This removes the
  produced-then-discarded pass-through the finding flagged.

The producer side (`ingest.ts` summary machinery, `RunAggregateSummary`,
`summaryFromBatchResults`, `runBatchWithSummary`, `reconcileAndBroadcast`) and
the wire contract (`RunProgressEvent.summary` in `live.ts`) are unchanged — the
summary was deliberately built as a deep, transactionally-consistent module
(covered by ingest orchestration tests that assert `event.summary`). The fix was
to make the broadcast _land_ on the client, not to delete it.

## Scope note

The finding named three SSR consumers (tiles, OutcomeBar, Tests-tab count). The
tiles + OutcomeBar are now live via the single island. The Tests-tab count
(`run.totalTests` in the sticky tab bar) was left SSR: it is structurally distant
from the summary block and making it live would require a second `/live`
connection for one digit. Documented as an intentional narrowing rather than
spawning a redundant subscription.

## Misleading e2e fixed

`packages/e2e/tests-dashboard/realtime.spec.ts` — the test formerly named
"summary counters update live" asserted against `getByRole("button", { name:
/^Failed/ })`, which matches the `SegmentedControl` filter pill inside
`RunProgress` (live via the `changedTests → byId → statusCounts` recompute), NOT
the published summary snapshot. Renamed to "header summary snapshot updates live"
and re-pointed at the header `OutcomeBar` (`role="img"`, accessible name built
from the aggregate counts), so it now genuinely exercises the
`RunProgressEvent.summary` path it claims to.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- `pnpm --filter @wrightful/dashboard test` — 449 passed (39 files), including the
  3 new `currentSummary` cases and the existing reducer + ingest-pipeline
  `event.summary` assertions.
- e2e not run here (requires a booted dashboard); the spec change is a
  locator/name update reviewed by hand.
