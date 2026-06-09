# 2026-06-07 — Realtime migrated to `void/ws` rooms (run + project), SSE kept as fallback

## What changed

Migrated the dashboard's realtime from `void/live` (SSE) to **`void/ws`
hibernatable rooms** — the decision recorded in `docs/adr/0001`. WebSockets are
now the **default** transport for both realtime surfaces:

- **Runs list** → `project:<id>` room (`/ws/project/:projectId`): `run-created`
  (new run prepends live) + `run-progress` (row fills in / flips status).
- **Run detail** → `run:<id>` room (`/ws/run/:runId`): the fine-grained
  `progress` event (summary + changed per-test rows).

`void/live` (SSE) is **retained behind `VITE_REALTIME_TRANSPORT=sse`** as a
fallback. It is NOT deleted: the ADR/cost gate (prod hibernation GB-s
measurement) hasn't run yet, and keeping the fallback is cheap reversibility.
The `user:<id>` notifications room is deliberately out of scope (net-new
feature, not a migration).

### Why (one line)

SSE can't hibernate → a Durable Object bills 128 MB continuously per open tab;
`void/ws` hibernates idle rooms → ~0 idle duration (≈30–74× cheaper at scale,
per the ADR cost model). The functional win was verified here; the cost win is a
prod measurement (the remaining gate).

## How it's built

| Area            | Files                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rooms (DOs)     | `routes/ws/project/[projectId].ws.ts`, `routes/ws/run/[runId].ws.ts` — `defineRoom`; `onBeforeConnect` reuses `authorizeTopicSubscription` (run/project team membership); `onRequest` broadcasts, gated by an `x-wrightful-internal: BETTER_AUTH_SECRET` shared secret (the room path is publicly registered by Void, so the internal-publish path must authenticate). |
| Event contracts | `src/realtime/events.ts` — `z.custom<T>()` schemas that type exactly as `ProjectFeedEvent` / `RunProgressEvent` yet validate permissively (a broadcast can't throw on field drift).                                                                                                                                                                                    |
| Publish         | `src/realtime/publish.ts` — `broadcastProjectRoom` / `broadcastRunRoom`; resolve the room DO via `requireRuntimeBinding(<ClassName>).idFromName(buildWebSocketInstanceId(...))` and POST to `onRequest`. **Non-fatal** (try/catch + log) so a realtime hiccup never fails the ingest write.                                                                            |
| Ingest wiring   | `src/lib/ingest.ts` — `broadcastRunUpdate` (single run-publish point) and the project sites dual-publish to the rooms behind `REALTIME_WS_PUBLISH` (default on).                                                                                                                                                                                                       |
| Client          | `src/realtime/use-room.ts` (generic), `use-project-room.ts`, `use-run-room.ts`; `use-run-live.ts` + the list page pick the hook by `VITE_REALTIME_TRANSPORT` at module load (default **ws** in code; `sse` opts back). Shared reducers `applyProjectFeedEvent` (`src/realtime/project-feed.ts`) + `applyRunProgressEvent` serve both transports.                       |
| Flags           | `env.ts` — `VITE_REALTIME_TRANSPORT` (default `ws`), `REALTIME_WS_PUBLISH` (default `true`).                                                                                                                                                                                                                                                                           |
| Comment fix     | `routes/live.ts` (stale "wss" → SSE, from the earlier tidy).                                                                                                                                                                                                                                                                                                           |

## Key decisions / non-obvious bits

- **Room = audience; event `type` = kind** (ADR). Run + project stay separate
  rooms (different granularity); a per-user room is reserved for notifications
  (no shared audience) and not built yet.
- **Broadcast from ingest** uses the room's `onRequest` hook (Void auto-registers
  `app.all(route.pattern)`), reached via the DO stub — `broadcast` is otherwise
  only callable inside the socket lifecycle. Verified against the runtime.
- **`z.custom` schemas**: a `looseObject` schema infers `{ [x]: unknown }` index
  signatures that don't match `ProjectFeedEvent` (broadcast type error);
  `z.custom<T>(() => true)` types exactly as the wire type and stays permissive.
- **Auth on the WS upgrade**: the Better Auth session cookie rides the
  same-origin upgrade → `ctx.user` in `onBeforeConnect` → reuse
  `authorizeTopicSubscription`. No `withCredentials` knob needed (unlike SSE).
- **Stuck runs**: the watchdog's terminal broadcast flows through
  `broadcastRunUpdate` + the project publish, so a stale-finalized run flips to
  `interrupted` live on BOTH WS rooms (ties into the stuck-run discussion).

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` → clean.
- `pnpm check:fix` → **0 errors**.
- `pnpm --filter @wrightful/dashboard test` → **618 passed / 55 files** (new:
  `project-feed.test.ts` — reducer + room schemas; dual-publish assertions added
  to `ingest-pipeline` + `reconcile-and-broadcast`).
- `pnpm --filter @wrightful/dashboard test:realtime` → **3 passed** (against a
  fresh dev server): project room streams an in-flight run; a run started after
  load appears + streams; run-detail per-test list streams — all over real
  `/ws/project` / `/ws/run` WebSockets, no reload.
- Manual probe: project room connect → auth → ingest broadcast → client render,
  end-to-end (`✓ connected over /ws/project, run appeared + streamed to /5`).

### Dev-server caveat (one-time)

Adding the `void/ws` deps to a **running** `pnpm dev` triggers a Vite dep
re-optimization that the long-running server serves stale → `504 Outdated
Optimize Dep` + a broken page. **Restart `pnpm dev` once** after pulling; a fresh
boot optimizes cleanly. (The e2e was verified against a fresh server for exactly
this reason.)

## Remaining / follow-ups

1. **Prod hibernation cost measurement** (ADR gate): deploy, open an idle room
   ~1h, confirm ~0 GB-s duration. Then delete the SSE plumbing (`routes/live.ts`,
   the `defineLiveStream` stream, `publishRunUpdate`/`publishProjectUpdate`, the
   SSE client hooks) and the transport flag.
2. **Deploy migration check**: `void deploy --dry-run` — confirm the new DO
   classes (`WsProjectProjectIdWs`, `WsRunRunIdWs`) are added additively without
   disturbing the existing `VOID_LIVE` DO.
3. **`user:<id>` notifications room** + a `lastActivityAt`-driven "stalled" badge
   (see the stuck-runs discussion).
4. Consider sharing one WS per run-detail tab (currently `RunSummaryLive` +
   `RunProgress` open 2 to the same `run:<id>` room).
