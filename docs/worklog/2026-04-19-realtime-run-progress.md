# 2026-04-19 — Realtime run progress via `useSyncedState` + prefilled queue rows

## What changed

Landed Playwright CLI/UI-parity for in-flight runs:

- At run open the dashboard prefills one `test_results` row per Playwright test
  with `status = "queued"`, so the run detail page already lists every planned
  test before any results stream in.
- As results flow through `/api/runs/:id/results`, the handler upserts the
  prefilled row in place (keyed on `(run_id, test_id)`) rather than
  inserting a new one — so each test's row updates live without
  duplicating.
- After every ingest write (open, results, complete), the worker composes
  a `RunProgress` snapshot from D1 and pushes it onto a per-run
  Cloudflare Durable Object via rwsdk's
  `SyncedStateServer.setState(value, key)`. Any client running
  `useSyncedState("progress", roomId)` receives the new value instantly.
- Run detail page renders two small client islands
  (`<RunSummaryIsland>` + `<RunTestsIsland>`) subscribed to the same
  `"progress"` key. Islands mount only when `run.status === "running"`;
  terminal runs render the same views directly from D1 with no WS
  connection.
- Runs list page does the same for rows whose run is currently
  running: `<RunRowProgressIsland>` replaces the SSR popovers with a
  live-updating cell that also shows a `done/expected` progress pill.

Because the DO is addressed only during streaming (writer side) and by
islands that only mount for running rows (reader side), completed runs
never touch the realtime layer.

## Architecture

**D1 is the source of truth.** Every write path that matters
(`openRunHandler`, `appendResultsHandler`, `completeRunHandler`) persists to
D1 first, then composes the full progress object from D1 and calls
`stub.setState(progress, "progress")` on the DO. Clients never see state that
D1 doesn't agree with.

**The DO is a pure delivery channel.** It holds only the most recent
progress snapshot in memory for the duration of a run. If a DO is evicted,
the next ingest write pushes a fresh snapshot; if a client connects cold,
the SSR-seeded `initial` covers the first render until the first post-mount
`setState` lands.

**Auth via `registerRoomHandler`.** Room IDs are shaped
`run:<teamSlug>:<projectSlug>:<runId>`. The handler parses the shape, grabs
the session via `getAuth().api.getSession({ headers: request.headers })`,
and rejects (throws) unless the user is a member of the team. Defense in
depth: ingest uses API-key auth on `/api/runs/*`, realtime uses Better Auth
sessions on the WS — separate surfaces.

Why we didn't use the legacy `renderRealtimeClients` pattern: the new
`useSyncedState` hook delivers the actual state object to the client, so
React doesn't need to re-fetch the RSC tree. That's a smaller, simpler
update path than re-render-pings, especially for the runs list where each
row is subscribed independently.

## Details

| Area                                                             | Change                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/reporter/src/index.ts`                                 | Extracted `buildTestDescriptor(test, rootDir)` so `onBegin` prefill and `buildPayload` compute identical testIds. Sent `plannedTests` at openRun.                                                                                 |
| `packages/reporter/src/types.ts`                                 | `OpenRunPayload.run.plannedTests: PlannedTestDescriptor[]`.                                                                                                                                                                       |
| `packages/dashboard/src/routes/api/schemas.ts`                   | `OpenRunPayloadSchema.run.plannedTests` (optional, default `[]`).                                                                                                                                                                 |
| `packages/dashboard/src/db/schema.ts`                            | Unique index `test_results_run_id_test_id_idx` on `(run_id, test_id)` — the anchor for prefill + upsert.                                                                                                                          |
| `packages/dashboard/drizzle/0000_*.sql`                          | Regenerated initial migration (squash convention) + hand-appended `CREATE VIEW committed_runs` (drizzle-kit doesn't emit `.existing()` views).                                                                                    |
| `packages/dashboard/src/routes/api/runs.ts`                      | `buildQueuePrefillStatements` at openRun; `resolveTestResultIds` + rewritten `buildResultInsertStatements` to UPDATE existing rows + replace their tags/annotations; `broadcastRunProgress(runId, scope)` fired after each write. |
| `packages/dashboard/src/routes/api/progress.ts` _(new)_          | `RunProgress` shape, `composeRunProgress(runId)`, `runRoomId(scope)`, `broadcastRunProgress`.                                                                                                                                     |
| `packages/dashboard/wrangler.jsonc`                              | `SYNCED_STATE_SERVER` DO binding + v1 migration `new_sqlite_classes: ["SyncedStateServer"]`.                                                                                                                                      |
| `packages/dashboard/src/worker.tsx`                              | Re-export `SyncedStateServer`, mount `syncedStateRoutes(...)`, `registerNamespace`, `registerRoomHandler` that enforces team membership.                                                                                          |
| `packages/dashboard/src/app/components/run-progress.tsx` _(new)_ | `RunProgressSummary` + `RunProgressTests` (pure), plus `RunSummaryIsland` / `RunTestsIsland` / `RunRowProgressIsland` (client, `useSyncedState`).                                                                                 |
| `packages/dashboard/src/app/pages/run-detail.tsx`                | Dropped local `StatusIcon`/`SummaryTile`/result fetch; uses `composeRunProgress` and mounts islands when running.                                                                                                                 |
| `packages/dashboard/src/app/pages/runs-list.tsx`                 | Per-running-row `composeRunProgress`; Tests cell renders `RunRowProgressIsland` when running, SSR popovers otherwise.                                                                                                             |
| `packages/dashboard/src/__tests__/runs.test.ts`                  | Updated DB mock to support awaitable `.where()` (for `resolveTestResultIds`) + more select results per test (scope + compose reads).                                                                                              |
| `packages/dashboard/src/__tests__/run-detail-scoping.test.ts`    | Added `cloudflare:workers` mock so import chain resolves.                                                                                                                                                                         |
| `packages/dashboard/src/__tests__/schemas.test.ts`               | New cases for `plannedTests` acceptance / rejection / default.                                                                                                                                                                    |
| `packages/reporter/src/__tests__/aggregation.test.ts`            | New case confirming `buildTestDescriptor` and `buildPayload` agree on testId/file/title for the same test.                                                                                                                        |

## Gotchas worth flagging

- **Migration squash churn**: per the pre-launch migration-squash
  convention we regenerated `0000_*.sql`, wiping local D1. The drift probe
  in `scripts/setup-local.mjs` picks this up automatically on next
  `setup:local` because the migration tag changed.
- **`SyncedStateServer.setState` argument order**: `(value, key)`. Easy to
  flip if you're used to React's `useState` / Redux's `(state, action)`.
  The rwsdk type signature is authoritative.
- **`resolveProjectScope` is now called on the hot path** in
  `appendResultsHandler` + `completeRunHandler` to get the scope for the
  room ID. One extra indexed select per ingest batch — negligible.

## Verification

- `pnpm --filter @wrightful/dashboard db:generate` — fresh initial
  migration; view SQL appended by hand.
- `pnpm typecheck` — clean.
- `pnpm test` — 90/91 passing. The one failure in
  `run-detail-scoping.test.ts` (`Maximum call stack size exceeded` inside
  drizzle's alias proxy) is a pre-existing mock/drizzle interaction and
  fails identically on the baseline tree. Not caused by this change.
- `pnpm lint` / `pnpm format` — clean.
- `pnpm --filter @wrightful/reporter build` — reporter picks up
  `plannedTests` payload.
- Manual smoke (user-run dev server): opening the detail page for a
  newly-started run should show all N tests as queued with neutral
  circle icons; as results stream, rows flip in place without a refresh.
  The runs list row's Tests cell shows `done/expected` progress and the
  per-status counts tick forward live.

## Follow-ups not in this PR

- `registerGetStateHandler` to rehydrate the DO from D1 if it's cold when
  a client connects first (currently the SSR `initial` covers that gap).
- Polling fallback for clients whose network blocks WebSockets.
- Presence ("who else is viewing this run") — natural second use of the
  same DO room, just a second key.
- **Per-file key split for large suites.** `useSyncedState` has no
  protocol-level diffing — every `setState(value, key)` broadcasts the
  full value under that key. The only way to get "changed-only" wire
  updates is to partition the blob across multiple keys in the same
  room. Per-test keys are too fine (N subscriptions on a 500-test
  suite); per-file keys are the sweet spot — typically 5–50 files, aligns
  with how Playwright workers pick up tests and how the UI groups them,
  and shrinks per-event payloads from ~50 KB to ~1–3 KB. Trigger condition:
  when the single-blob snapshot shows up as latency, Cloudflare egress
  cost, or island re-render overhead. Until then, single-blob wins on
  simplicity.
