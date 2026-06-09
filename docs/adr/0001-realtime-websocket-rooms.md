# ADR 0001 — Realtime over `void/ws` rooms (room = audience, event type = kind)

- **Status:** Accepted & implemented — `void/ws` rooms (run + project) are the **only** realtime transport. `void/live` SSE has been **deleted entirely** (no feature flag): the room migration is the realtime, full stop. **Pre-deploy gate:** the SSE `VOID_LIVE` Durable Object class is removed, so the next `void deploy` carries a DO-class deletion migration — confirm it before shipping (see Risks). The prod hibernation cost measurement is now an after-the-fact confirmation, not a gate.
- **Date:** 2026-06-07
- **Deciders:** dashboard team
- **Supersedes & replaces:** the `void/live` (SSE) realtime (removed).

## Implementation status (2026-06-07)

Built + verified (see worklogs `2026-06-07-realtime-ws-migration.md`, `2026-06-07-delete-sse-realtime.md`, and `2026-06-07-realtime-ws-review-hardening.md`):

- **Rooms:** `routes/ws/project/[projectId].ws.ts`, `routes/ws/run/[runId].ws.ts` — `defineRoom`, hibernatable, server-push, heartbeat-free, `onBeforeConnect` auth via the existing `authorizeTopicSubscription` **+ a 256-connection cap** (`roomAtCapacity`), `onRequest` broadcast gated by a **constant-time** internal-secret check (`isInternalRequest`) over a **build-time-baked secret** (a per-deploy random `define`d into the server bundle — zero-config, decoupled, auto-rotating; `REALTIME_INTERNAL_SECRET` env optionally pins it; **never** falls back to `BETTER_AUTH_SECRET` — throws if neither is present), with the body **schema-validated** (not asserted) before fan-out. Helpers in `src/realtime/room-server.ts`.
- **Publish:** `src/realtime/publish.ts` (`broadcastProjectRoom` / `broadcastRunRoom`) called **unconditionally** from ingest (`broadcastRunUpdate` + the project sites). Non-fatal (a realtime hiccup never fails the ingest write).
- **Client:** `useProjectRoom` / `useRunRoom` (over the generic `useRoom`) — the only realtime hooks. The pure reducers (`applyProjectFeedEvent` in `src/realtime/project-feed.ts`, `applyRunProgressEvent` in `src/realtime/run-progress.ts`) and the wire contracts (`src/realtime/events.ts`) are the shared core.
- **SSE removed:** deleted `src/live.ts`, `src/lib/live-client.ts`, `routes/live.ts`, `src/realtime/use-run-live.ts`, and the `VITE_REALTIME_TRANSPORT` / `REALTIME_WS_PUBLISH` env flags. Shared types/reducers relocated under `src/realtime/`.
- **Wire payload:** the run-room event carries only the fields the live list renders — `errorMessage`/`errorStack` are NOT broadcast (loaded from D1 on the test-detail page) to keep events well under the frame ceiling. See the hardening worklog.
- **Verified:** typecheck clean; 663 unit tests (reducers, room schemas + guards, auth gate, the publish path, the room `onRequest`/`onBeforeConnect` handlers, connection cap, secret resolution/constant-time check); `pnpm check` 0 errors; production `vp build` succeeds (client + server bundle). WS e2e lives in `packages/e2e/tests-dashboard/realtime.spec.ts` (the canonical dashboard suite, self-booting on :5189) — covers streaming + completion on the list and run-detail; run via `pnpm --filter @wrightful/e2e test:dashboard`.
- **Not done (deliberate):** the `user:<id>` notifications room (net-new feature, not a migration); presence; mid-socket auth revocation (auth is connect-time only).
- **Caveat:** adding the `void/ws` deps wedges a **long-running** dev server with `504 Outdated Optimize Dep` — restart `pnpm dev` once after pulling (one-time Vite re-optimization).

## Context

Realtime run progress currently rides `void/live` (SSE). It works, but the SSE
model has a structural cost problem and a few sharp edges we hit while shipping
the runs-list live feed:

- **SSE can't hibernate.** Each browser connection pins a Durable Object holding
  an open `eventStream` + a 15 s keep-alive `setInterval` (`sse.mjs:100`, wired
  at `live-server.mjs:67`) and `await stream.closed` (`live-server.mjs:60`). The
  DO is therefore billed at a flat 128 MB **continuously, for the whole time a
  tab is open**, whether or not anything is streaming.
- **One connection DO per viewer**, plus per-event DO-to-DO `/deliver` fan-out
  (1 list-read + N delivers per publish, `live-server.mjs:240,257-268`).
- **HTTP/1.1 connection cap (~6/origin)** bit us in dev: per-row SSE connections
  exhausted the budget and hung navigation (see worklog 2026-06-06).

We evaluated migrating realtime to `void/ws`, which is built on Cloudflare's
**WebSocket Hibernation** API (`this.state.acceptWebSocket()`,
`ws-server.mjs:197`) with `defineRoom` — one DO per room holding many
connections, with a free `broadcast()` (`ws-server.mjs:121-127`).

This decision was investigated by reading the Void SSE and WS runtimes under the
hood, building a grounded cost model, and adversarially verifying the design
(verdict: **go-with-caveats**; both potential blockers — broadcast-from-ingest
and hibernation preconditions — cleared against source).

## Decision

Adopt **`void/ws` rooms** for realtime, organized by the rule:

> **A room = the audience/scope of the data (the DO sharding key).
> An event `type` = the kind of data within that scope.**

Add new realtime by adding an event `type` to the room whose _audience_ matches;
add a new room route only for a genuinely new audience.

### Room taxonomy

| Room (route `*.ws.ts`)   | DO key           | Audience                         | Granularity                                | Opened by              |
| ------------------------ | ---------------- | -------------------------------- | ------------------------------------------ | ---------------------- |
| `/ws/run/:runId`         | `runId=<id>`     | viewers of one run               | fine: per-test deltas + summary            | run-detail page        |
| `/ws/project/:projectId` | `projectId=<id>` | viewers of a project's runs list | coarse: run lifecycle (created / progress) | runs-list page         |
| `/ws/user/:userId`       | `userId=<id>`    | one signed-in user, all tabs     | notifications / cross-cutting toasts       | root layout (app-wide) |

**Why run and project stay separate** (not merged): different audiences ⇒
different DO shards; merging would broadcast every run's fine-grained per-test
events to every list viewer and force client-side filtering. They also have
different lifetimes and hibernate independently.

**Why `user:<id>` is the _only_ per-user room** (and run/project are not
collapsed into a per-user connection): `room.broadcast` fans out **for free** to
all sockets in one DO (`ws-server.mjs:121-127`). A per-user-connection design
would force a run/project update to be **relayed DO-to-DO to every viewer's user
DO** — reintroducing exactly the billed fan-out (`live-server.mjs:257-277`) that
WS is meant to eliminate. So: scope rooms for anything with a shared audience; a
per-user room only for genuinely per-user payloads (notifications) that have no
shared audience.

### Event envelopes (discriminated unions)

One union per room, reusing the existing wire types in `src/live.ts`:

- `/ws/run/:runId` → `RunProgressEvent` (`{ type: "progress"; changedTests; summary }`).
- `/ws/project/:projectId` → `ProjectFeedEvent` (`run-created` | `run-progress`).
- `/ws/user/:userId` → `{ type: "notification"; id; kind; title; href?; … }` (new).

The summary in run/project events also carries **`lastActivityAt`** so the
client can render a "stalled — no updates for Nm" badge on a running run without
waiting for the watchdog (see "Stuck runs" below). Client messages are a
push-only `{ type: "ping" }` no-op union (dashboards are server-push). Each event
must stay under the 64 KiB `maxEncodedEventSize` ceiling.

### Auth per room

In `onBeforeConnect`, returning a `Response` rejects the upgrade
(`ws-server.mjs:190`); `ctx.user` is resolved from the Better Auth session
cookie on the handshake (`ws-server.mjs:174`). Reuse the existing lookups
verbatim:

| Room    | Gate                            | Lookup                                     |
| ------- | ------------------------------- | ------------------------------------------ |
| run     | member of run's team            | `lookupRunMembership` (`authz.ts:316`)     |
| project | member of project's team        | `lookupProjectMembership` (`authz.ts:343`) |
| user    | `ctx.user.id === params.userId` | identity equality (no DB)                  |

Carried-over (non-regression) caveat: auth is **team-scoped**, not per-project
ACL — a team-A member may subscribe to any of team A's projects. Same as SSE.

### Ingest → room broadcast contract

`broadcast()` is reachable only inside a room hook, so an external HTTP caller
(our `/api/runs/*` ingest) reaches it via the room's **`onRequest`** hook
(`ws-server.mjs:210-221`). Void auto-registers a plain HTTP route at the room's
path (`app.all(route.pattern) → forwardWebSocketRequest`, `index.mjs:2688-2691`),
and the DO stub resolves exactly like `void/live` resolves its publish target —
`binding.idFromName(buildWebSocketInstanceId(route, params))` (`ws-server.mjs:276`,
cf. `live.mjs:49`). A thin `broadcastProjectRoom(projectId, event)` mirrors the
existing `publishProjectUpdate` so the ingest call sites change by one line.

### Notifications (`/ws/user/:userId`)

Triggered from `completeRun` (`ingest.ts`), where terminal status is known.
Target resolution: map `runs.actor` → account via `userGithubAccounts` when it's
a GitHub login; **fall back to team owners** (`memberships.role = 'owner'`) so a
bot-actor run still notifies someone. Toasts are ephemeral (no replay); a
persistent inbox would need a new `notifications` table (out of scope here). The
`id` field enables client dedupe across reconnects.

### Presence (deferred, near-free)

`state.getWebSockets()` (`ws-server.mjs:123`) makes "N people viewing this run"
computable with zero extra storage. **Deferred past the spike** — broadcasting on
connect/disconnect wakes the room and erodes hibernation; add it behind its own
flag and re-measure.

### Client abstraction

A generic `useRoom(path, params, onEvent)` over `connect()` (auto-reconnect,
cookies ride the same-origin upgrade — no `withCredentials` needed), plus an
app-wide `useUserChannel()` mounted in the layout. The existing pure reducers
(`applyRunProgressEvent`, the project-feed merge in `live-client.ts`) are
transport-agnostic and reused unchanged.

## Cost analysis

DO pricing (verified June 2026): requests $0.15/M (1M free); duration $12.50/M
GB-s (400k free) at a flat 128 MB; SQLite rows write $1/M, read $0.001/M. 1
connection-hour ≈ 450 GB-s ≈ $0.0056; free tier ≈ 889 connection-hours/mo.

The dominant meter is **duration**, and the dominant variable is **`f_idle`**
(fraction of open-tab time with no events — ~95–99% for a dashboard). SSE bills
128 MB regardless of `f_idle`; WS bills duration only while a room is non-idle
(hibernation).

| Scenario                      | SSE $/mo | WS $/mo | Note                                           |
| ----------------------------- | -------- | ------- | ---------------------------------------------- |
| ~10 concurrent viewers        | ~$2.4    | ~$0     | SSE just clears the free duration tier         |
| ~100 concurrent, mostly idle  | ~$69     | ~$0     | SSE duration = 99% of cost; WS under free tier |
| ~1000 concurrent, mostly idle | ~$740    | ~$10    | ~74× cheaper; SSE conn-duration = 99.6%        |

**Free-tier cliff:** SSE crosses 400k GB-s at **~7 concurrent viewers**, then
bills linearly with viewer-hours. WS doesn't start billing duration until
`~7/(1−f_idle)` ≈ **225–350 concurrent viewers** — a ~30–50× higher ceiling on
the dominant meter. WS does _not_ reduce publish requests (both issue `R·2B`
publishes), but eliminates the `R·B·(S_run+S_proj)` deliver-fetch fan-out
(robustness/latency win; requests are cheap anyway).

**The cost case rests on one empirical assumption:** that idle WS rooms actually
hibernate under our cadence. Code satisfies every precondition (acceptWebSocket,
instance message/close handlers, serialized attachments, **zero server-side
timers** in the WS path), but actual eviction is a Cloudflare runtime behavior
**provable only by measuring deployed GB-s** — which is the spike's success gate.

## Consequences / risks

| Risk                                                                                    | Severity                           | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deploy carries a DO-class DELETION migration** — SSE removed → `VOID_LIVE` class gone | **high (active pre-deploy gate)**  | The `VOID_LIVE` SQLite DO class is no longer declared. Cloudflare requires removed DO classes to be declared as `deleted_classes` in the migration, else `void deploy` errors. Before the next prod deploy: `void deploy --dry-run` / inspect the generated manifest; confirm `VOID_LIVE` is dropped via `deleted_classes` (not silently re-added) and the new `void-ws-v1` classes are present. Never hand-edit `wrangler.jsonc` migrations. |
| Idle rooms don't actually hibernate → cost thesis weaker than projected                 | medium (empirical, after-the-fact) | No longer a gate (SSE is gone, there's no fallback to keep). Confirm post-deploy: open one idle authenticated connection ~1h, read DO GB-s. ~0 ⇒ thesis holds; continuous ⇒ WS still wins on deliver-fetch elimination, just less.                                                                                                                                                                                                            |
| Single DO per room = fan-out CPU ceiling + per-project blast radius                     | medium → **mitigated**             | **Done:** 256-connection cap in `onBeforeConnect` (`roomAtCapacity`, restoring the old SSE `maxSubscriptionsPerTopic`). Blast radius is one project (good isolation).                                                                                                                                                                                                                                                                         |
| Forged broadcast on the public room path / secret reuse / non-constant-time compare     | medium → **mitigated**             | **Done:** build-time-baked per-deploy internal secret (`__WRIGHTFUL_INTERNAL_SECRET__` `define`d into the server bundle — decoupled from `BETTER_AUTH_SECRET`, auto-rotating, zero-config; `REALTIME_INTERNAL_SECRET` env optionally pins it), constant-time `isInternalRequest`, and the POST body is schema-validated (real guards, not `() => true`) before fan-out. See hardening worklog.                                                |
| Oversized broadcast drops the whole event for all viewers (no per-socket catch in Void) | medium → **mitigated**             | **Done:** the run-room wire row no longer carries `errorMessage`/`errorStack`, keeping events well under the frame ceiling.                                                                                                                                                                                                                                                                                                                   |
| VoidSocket reconnect storm on an expired-session tab (flat 1s, no cap)                  | medium                             | Softened: `useRoom` passes `reconnectDelayMs: 3000`. Void exposes only a flat delay; the auth-expiry reconnect can't be fully stopped client-side — accepted.                                                                                                                                                                                                                                                                                 |
| Adding a heartbeat/presence defeats hibernation + adds billed incoming msgs (20:1)      | medium                             | Rooms are **server-push-only, heartbeat-free, no presence**. Defer presence; gate behind its own flag and re-measure.                                                                                                                                                                                                                                                                                                                         |
| No event replay on reconnect                                                            | low                                | Not a regression — the consumer tolerates the gap (SSR seed + id-dedupe).                                                                                                                                                                                                                                                                                                                                                                     |
| Auth cookie not sent on WS upgrade (cross-origin/SameSite)                              | low                                | App + worker are same-origin (one worker), so SameSite=Lax rides the handshake. `ctx.user` confirmed non-null in dev.                                                                                                                                                                                                                                                                                                                         |

## Rollout

The flag-gated A/B in the original draft was collapsed: WS shipped as the default
and the SSE path was deleted outright (the user's call — "realtime only, no
feature gate"), so there is no fallback to A/B against.

1. ✅ `/ws/project/:projectId` + `/ws/run/:runId` rooms + ingest publish + client
   hooks landed; WS made the default; SSE (`void/live`) deleted.
2. **Next deploy:** run `void deploy --dry-run` and confirm the `VOID_LIVE`
   DO-class **deletion** migration is correct (see Risks) before shipping.
3. Post-deploy: measure idle DO GB-s to confirm the hibernation cost win.
4. Future: `/ws/user/:userId` notifications room — WS-only (no SSE predecessor).

## Alternatives considered

- **Stay on SSE (`void/live`).** Simplest; fine below ~7 concurrent viewers. But
  cost grows linearly with viewer-hours and the model is structurally wrong for a
  mostly-idle dashboard. Near-term mitigation if we _don't_ migrate:
  close-the-stream-when-tab-hidden (cuts idle duration without a rewrite).
- **One per-user multiplexed WS connection** (server routes everything to it).
  Rejected: forfeits free broadcast — subject updates become DO-to-DO relays to
  each viewer's DO, the exact cost WS is meant to remove. The per-user room
  exists _only_ for payloads with no shared audience (notifications).

## Open questions (resolve at / after the next deploy)

1. Confirm the deploy migration drops `VOID_LIVE` via `deleted_classes` and adds
   the WS DO classes (run a dry-run) — **this is now a hard pre-deploy gate**, see
   Risks.
2. Confirm idle hibernation by measuring deployed GB-s (post-deploy confirmation,
   no longer a go/no-go since there's no SSE fallback to revert to).
3. Pull real `B` (batches/run), `S_run`, `S_proj` from production to sharpen the
   request-meter estimate (does not change the duration conclusion).
