# 2026-05-23 — Void live-stream tightening

Cleaned up the `void/live`-based realtime path in `packages/dashboard-void` after
an architecture review. Four classes of issue: a redundant DB round-trip on
every ingest batch, snapshot inconsistency between the broadcast summary and
the writes that produced it, an SSR seed that was being discarded on mount,
and dead anonymous-auth code.

## What changed

### 1. Broadcast summary now comes from inside the batch

`broadcastRunUpdate` used to issue its own `SELECT runs WHERE id = …` _after_
the ingest batch committed. That added an extra D1 round-trip per
`/api/runs/:id/results` call and — more importantly — wasn't snapshot-
consistent with the writes that just landed (another ingest batch could
sneak in between the UPDATE and the SELECT, and we'd broadcast a future-state
summary alongside the current `changedTests`).

The fix:

- `aggregateDeltaStatement` and `aggregateRecomputeStatement` now chain
  `.returning(AGGREGATE_SUMMARY_COLUMNS)`, so the publishable summary falls
  out of the UPDATE itself as the last entry in the batch result array.
- New `aggregateSummarySelectStatement` covers the no-delta path in
  `/results` (when test rows update but status buckets don't change) — it's
  appended to the same batch, so the snapshot is still in-transaction.
- `broadcastRunUpdate` is now pure pub: it takes `(runId, changedTests,
summary)` and just calls `live.publish`. No DB I/O.
- `/api/runs` (open) synthesizes the summary inline from the values it just
  inserted — no read at all on the happy path.

Net effect: ingest is one D1 round-trip cheaper per batch _and_ the published
event is always transactionally consistent.

### 2. `useRunProgress` seeds from SSR

Previously the hook initialized `byId = {}` and `summary = null`. The
run-detail page already loaded tests + aggregate counts in its loader, but
the hook ignored them — finished runs (no events to come) rendered empty
until a manual refetch, and live runs flashed blank on hydration.

The hook now accepts `initialTests` / `initialSummary` options and seeds
state from them at mount. `<RunProgress>` forwards the loader data straight
through and drops its manual `Map<id, RunProgressTest>` merge. The seed is
captured once per `runId`; subsequent prop changes don't clobber live state.

### 3. Anonymous-subscribe check removed

`onSubscribe` had a leading `if (!session) return new Response("Unauthorized",
{ status: 401 })`. This was dead code: `void/live` with the default
`allowAnonymousControl: false` already rejects the connect handshake when
`identifyConnection` returns `null` (see `node_modules/void/dist/runtime/
live.mjs:35`). The unauthorized branch was unreachable.

Removed it. Also switched `onSubscribe` to read `ctx.user` (plumbed through by
void from `identifyConnection`) instead of calling `getSession()` a second
time per subscribe.

### 4. Inline documentation for deferred choices

Added comments explaining:

- Why `maxSubscriptionsPerTopic: 256` and what happens above it
  (`TOPIC_FULL` error surfaced to clients).
- That `broadcastRunUpdate` callers own summary consistency now, not the
  publish helper.
- That `useRunProgress` captures the seed once at mount on purpose.

## Files

| File                               | Change                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/ingest.ts`                | New `AGGREGATE_SUMMARY_COLUMNS` const + `RunAggregateSummary` type. `.returning()` on both aggregate UPDATE helpers. New `aggregateSummarySelectStatement`. `broadcastRunUpdate` now pure. |
| `routes/api/runs/index.ts`         | Synthesize summary inline post-insert.                                                                                                                                                     |
| `routes/api/runs/[id]/results.ts`  | Push summary stmt onto the batch, read from batch result.                                                                                                                                  |
| `routes/api/runs/[id]/complete.ts` | Read summary from the recompute's RETURNING row.                                                                                                                                           |
| `src/live.ts`                      | Drop dead anon check, use `ctx.user`, doc the limits.                                                                                                                                      |
| `src/lib/live-client.ts`           | New `UseRunProgressOptions` with `initialTests` / `initialSummary`. Seed state at mount. Export `RunProgressSummary`.                                                                      |
| `src/components/run-progress.tsx`  | Forward seeds to hook, drop manual merge, reuse `RunProgressSummary`.                                                                                                                      |

No schema changes. No new dependencies.

## Verification

- `pnpm exec vp check --fix` — 0 errors, 75 warnings (all pre-existing
  `no-unsafe-type-assertion` in unrelated files).
- `pnpm exec vp test` — 6 files, 81 tests passed.

Not manually exercised end-to-end. The publish path is covered by route
handler integration, which would need a live D1 + Workers session to verify
end-to-end. The summary types align with the existing `RunProgressEvent`
contract; if D1 batch `.returning()` returned a shape mismatch the type
errors would surface here (the casts are intentional and match the existing
`as never` style elsewhere in this file).
