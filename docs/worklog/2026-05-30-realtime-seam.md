# 2026-05-30 — Realtime seam: pure progress reducer, summary contract & vestige cleanup

Cluster slug: `realtime-seam`. Findings: F19, F20, F22, F23 (implemented);
F21, F77 (not applied — see below). This entry rolls up the whole cluster; the
F19/F20 detail also lives in `2026-05-30-live-run-summary-island.md`, written
during implementation.

## What changed

The realtime path (`void/live` topic `run:<runId>`) had its consumer-side
behaviour smeared across the `useRunProgress` hook and the run-detail page:
the seed/merge logic was inlined in the hook, the published summary was
broadcast but discarded by the only client consumer, and the sole
tenant-isolation gate for the stream was an inline async closure inside the
`defineLiveStream` literal — untestable without a real handshake against D1.
This cluster concentrates each of those into a small, unit-testable seam.

### F20 — pure progress reducer (`src/lib/live-client.ts`)

Extracted the merge/seed logic that was inlined inside `useRunProgress` into a
pure reducer pair plus a coalesce helper:

- `seedRunProgressState(initialTests?, initialSummary?) -> { byId, summary }` —
  builds `byId` keyed by row id (last-writer-wins), defaults `summary` to null.
- `applyRunProgressEvent(prev, event) -> next` — pure, never mutates `prev`.
  Encodes the four merge rules: ignore non-`"progress"` events (return `prev`
  by reference); replace (not merge) `summary`; no-op the `byId` clone on an
  empty `changedTests` (referential stability for the list consumer); else
  merge `changedTests` into a cloned `byId` (last-writer-wins).

`useRunProgress` is now thin glue: seed once at mount, subscribe, fold each
event through `applyRunProgressEvent`. The reducer is unit-tested against the
real `RunProgressEvent`/`RunProgressTest` wire types (no React, no WebSocket).

### F19 — make the broadcast summary load-bearing

Ingest builds and broadcasts a transactionally-consistent
`RunProgressEvent.summary` on every write (and it is the entire payload of
`completeRun` — `changedTests: []` + summary), but the only client consumer
threw it away while the header rendered the tiles + `OutcomeBar` from static
SSR `run.*` props that never re-render on a live event. We wired the published
summary to the header:

- New `<RunSummaryLive>` client island (`src/components/run-summary-live.tsx`)
  owns the per-status `SummaryStat` tiles + the `OutcomeBar`, reading
  `useRunProgress(runId).summary` (seeded by `initialSummary`). One
  subscription drives both. `"use client"` stays at this leaf, not the page
  root (islands ADR).
- New pure helper `currentSummary(state, fallback)` in `live-client.ts`
  concentrates the "live snapshot, else SSR fallback" coalesce so every header
  consumer shares one unit-tested rule.
- The run-detail page renders the island in place of the static tiles/bar and
  passes `run.*` only as the seed. `RunProgress` no longer accepts/forwards
  `initialSummary` — it owns the per-test list and derives counts from its own
  `byId`. This removes the produced-then-discarded pass-through.

### F23 — extract the realtime tenant-isolation gate (`src/lib/authz.ts`)

`onSubscribe` was an inline async closure inside the `defineLiveStream`
literal — the sole realtime isolation gate (`runs ⋈ memberships`) and
untestable without a `void/live` handshake + real D1. Extracted into
`authorizeTopicSubscription(userId, topic, lookup?)` with an injected
`RunMembershipLookup` (the DB-bound half). The pure decision — topic parse
(`run:<runId>` exactly), null/empty-user rejection, empty-rows cross-team
denial — is now unit-testable with a fake lookup. `src/live.ts#onSubscribe`
is a thin adapter that translates the decision into a `void/live` `Response`.
This is the realtime analogue of the `AuthorizedProjectId` scope predicate —
the one isolation check that can't route through a branded id because the
handshake hands us a raw topic string.

### F22 — vestige cleanup

Removed the residual rwsdk/`SyncedStateServer` framing. The `useSyncedState`
re-export + its DO doc block in `live-client.ts` were already dropped by the
F20 reducer refactor. `ingest.ts`'s pipeline doc comment lost its
"differences from the DO version" framing in favour of describing the
single-D1 + `void/live` model directly (pointing at
`void-migration-consolidated.md`). The e2e `realtime.spec.ts` header/describe
text was repointed from "SyncedStateServer DO" to "void/live topic
run:<runId>", and its summary assertion now targets the published-summary
`OutcomeBar` (`role="img"`, accessible name from the aggregate counts) rather
than the `SegmentedControl` filter pill (which is fed by the per-test
recompute, not the broadcast summary) — so it genuinely exercises the
`RunProgressEvent.summary` path it claims to.

## Findings not applied

- **F21 (bounced).** The finding claimed the two `type: "progress"` literals
  in `live.ts` were a duplicated value to dedupe. They are not: one is the
  envelope discriminant on `RunProgressEvent`, the other is the SSE event
  `type` passed to `live.publish`. Different roles; collapsing them would
  couple two contracts that happen to share a string. No change.
- **F77 (already addressed).** Its only zero-risk core was deleting the dead
  `useSyncedState` alias in `live-client.ts`, which the F20 refactor had
  already removed. Nothing left to do.

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (0 errors).
- `pnpm --filter @wrightful/dashboard test` — 461 passed (40 files), including
  the new `run-progress-reducer.test.ts` (seed/apply/`currentSummary` cases)
  and `authorize-topic-subscription.test.ts` (topic regex, no-user 403,
  cross-team empty-rows denial via a faked lookup).
- `pnpm --filter @wrightful/reporter test` — 150 passed (11 files).
- `pnpm check` — 0 errors, 78 warnings (pre-existing
  `no-unsafe-type-assertion` / `no-underscore-dangle` warnings; within budget).
- e2e not run here (requires a booted dashboard). The `realtime.spec.ts`
  change is a locator/name update; the targeted `OutcomeBar` `aria-label`
  (`"N passed, N failed, N flaky, N skipped"`) was verified against the
  component source by hand.
