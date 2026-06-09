# 2026-06-07 — Delete `void/live` SSE realtime entirely (WS rooms only, no flag)

## What changed

Removed the `void/live` SSE realtime path completely. Following the WS-rooms
migration earlier the same day (`2026-06-07-realtime-ws-migration.md`, which kept
SSE behind a `VITE_REALTIME_TRANSPORT=sse` flag as a fallback), the user's call
was unambiguous: **"delete the live code completely — we want realtime only, no
feature gate."** So `void/ws` rooms (run + project) are now the **only** realtime
transport; the transport flag and the dual-publish gate are gone.

This is a deletion + relocation refactor, not a behaviour change: the WS room
runtime (rooms, publishers, client hooks, pure reducers) is functionally
identical to what shipped in the migration worklog. What moved is that the SSE
alternative was removed and the **shared** types/reducers that used to live in the
SSE-named modules were relocated under `src/realtime/`.

## Files deleted

| File                           | Was                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `src/live.ts`                  | `defineLiveStream` (the `VOID_LIVE` DO) + `publishRunUpdate` / `publishProjectUpdate` + the wire types |
| `src/lib/live-client.ts`       | SSE client hooks (`useRunProgress`, `useProjectRunFeed`, `connectLiveStream`) + the pure run reducers  |
| `routes/live.ts`               | the SSE HTTP control endpoint (`/live`)                                                                |
| `src/realtime/use-run-live.ts` | the run-detail transport-selection shim (`useRunLive` = sse?useRunProgress:useRunRoom)                 |

## Shared code relocated (kept — NOT deleted)

`src/live.ts` and `src/lib/live-client.ts` were _mixed_ modules: SSE machinery
**plus** wire contracts and pure reducers that the WS path also depends on. The
shared half was moved, not dropped:

| Symbol(s)                                                                                                                                                     | From                     | To                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `RunProgressTest`, `RunProgressEvent`, `RunListRowData`, `ProjectFeedEvent` (wire types)                                                                      | `src/live.ts`            | `src/realtime/events.ts` (co-located with the room zod schemas that type against them)                |
| `seedRunProgressState`, `applyRunProgressEvent`, `currentSummary`, `RunProgressState`, `RunProgressSummary`, `RunProgressTestStatus`, `UseRunProgressOptions` | `src/lib/live-client.ts` | new `src/realtime/run-progress.ts` (the run-detail reducer, mirroring `project-feed.ts` for the list) |

After this, all realtime contracts + reducers live under `src/realtime/`:
`events.ts` (wire types + room schemas), `project-feed.ts` (list reducer),
`run-progress.ts` (run-detail reducer), `publish.ts` (server publishers),
`use-room.ts` / `use-project-room.ts` / `use-run-room.ts` (client hooks).

## Other code changes

- **`src/lib/ingest.ts`** — dropped `import { env }` and the `@/live` publisher
  imports; type imports repointed to `@/realtime/events`. The four publish sites
  (`broadcastRunUpdate`, `reconcileAndBroadcast`, `openRun`, `appendRunResults`)
  no longer call `publishRunUpdate` / `publishProjectUpdate` and no longer gate on
  `REALTIME_WS_PUBLISH` — they broadcast to the rooms **unconditionally** via
  `broadcastRunRoom` / `broadcastProjectRoom`.
- **`env.ts`** — removed `VITE_REALTIME_TRANSPORT` and `REALTIME_WS_PUBLISH`.
- **`pages/.../[projectSlug]/index.tsx`** — removed the module-const transport
  selection; the list calls `useProjectRoom` directly.
- **`src/components/run-summary-live.tsx`, `run-progress.tsx`** — `useRunLive` →
  `useRunRoom`; reducer/type imports repointed to `@/realtime/run-progress`.
- **`run-list-row.tsx`, `lib/group-tests-by-file.ts`, `lib/run-results-page.ts`** —
  type imports repointed (`@/live` → `@/realtime/events`, `@/lib/live-client` →
  `@/realtime/run-progress`).
- Stale `void/live` / `useRunProgress` references in comments swept across
  `authz.ts`, the `.ws.ts` route docstrings, the run-detail loader, the e2e
  config/spec, and `ingest.ts`.

## Tests

- **`ingest-pipeline.test.ts`, `reconcile-and-broadcast.test.ts`** — dropped the
  `@/live` mock (publishers gone) and the `void/env` mock (ingest no longer
  imports `env`, returning these to their pre-migration mock surface). The
  broadcast assertions now target the WS room spies (`broadcastRunRoom` /
  `broadcastProjectRoom`) as the single publish path, replacing the
  SSE-spy + dual-publish-spy pairs.
- **`run-progress-reducer.test.ts`, `project-feed.test.ts`,
  `group-tests-by-file.test.ts`** — import repoints only.

## Verification

- `void prepare` → regenerated `.void/{routes,env,db}.d.ts` (the deleted `/live`
  route + the removed env keys drop out cleanly).
- `pnpm --filter @wrightful/dashboard run typecheck` → **clean** (exit 0).
- `pnpm --filter @wrightful/dashboard test` → **618 passed / 55 files**.
- `pnpm check:fix` → **0 errors** (92 warnings, all pre-existing in
  `packages/e2e`, untouched here).
- `pnpm --filter @wrightful/dashboard build` (`vp build`) → **succeeds**, client +
  server bundle (run-detail / runs-list islands compile; no dangling import of a
  deleted module; client/server boundary intact after the type relocation).
- WS e2e (`e2e/realtime.spec.ts`) is unchanged from the migration and was green
  last session; not re-run here (no dev server spawned, per the standing
  preference — and a running dev server needs a restart to pick up these
  deletions anyway).

## Deploy gate (important)

Removing `src/live.ts` removes the `VOID_LIVE` Durable Object class. Cloudflare
requires a removed DO class to be declared as `deleted_classes` in the migration,
or `void deploy` errors. **Before the next prod deploy, run `void deploy
--dry-run` and confirm the generated migration drops `VOID_LIVE` via
`deleted_classes`** (and adds the `void-ws-v1` classes). Do not hand-edit
`wrangler.jsonc` migrations. See `docs/adr/0001` Risks.

## Follow-ups

1. The deploy DO-deletion migration check above (hard gate).
2. Post-deploy: measure idle room GB-s to confirm the hibernation cost win (now a
   confirmation, not a go/no-go — there's no SSE to fall back to).
3. `user:<id>` notifications room (net-new, WS-only) + a `lastActivityAt` stalled
   badge.
