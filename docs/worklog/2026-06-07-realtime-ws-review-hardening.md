# 2026-06-07 — Realtime/WS review: proper types, best-practice + security hardening, coverage

## What changed

A full review of the `void/ws` realtime surface (run + project rooms, publisher,
client hooks, reducers, schemas, auth) against Void + Cloudflare best practice,
driven by an adversarial multi-agent review (types / best-practice / security /
coverage, each finding empirically verified against Void's type defs). Acted on
every confirmed high/medium finding plus the cast cleanups the user flagged.

## Types — replaced `as` casts with real Void types

Void's type surface (verified in `node_modules/void/dist/runtime/ws.d.mts`,
`ws-server.d.mts`, `env.d.mts`) already provides what the casts were asserting:

| Cast (before)                                                                           | Now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.user as { id: string } \| null` (both `.ws.ts`)                                    | removed — `RoomContext.user` is already `AuthUser \| null` (`ctx.user?.id ?? null`)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `requireRuntimeBinding(name) as RoomNamespace` (`publish.ts`)                           | `requireRuntimeBinding<DurableObjectNamespace>(name)` — the API is generic; `@cloudflare/workers-types` is in scope via `void/env`. Deleted the hand-rolled `RoomNamespace` interface. An id/name swap is now a type error.                                                                                                                                                                                                                                                                                                     |
| `connect as unknown as (path: string, …) => LooseSocket` + `event as E` (`use-room.ts`) | `useRoom<P>` / `subscribeToRoom<P>` are generic over `keyof WebSocketRouteMap`; `connect` is bridged to its **resolved-for-our-rooms** signature (one cast, because `ConnectOptions<P>`'s `HasParams<P>` conditional can't resolve for a free generic and isn't exported) so path/params/event stay fully typed. `useProjectRoom`/`useRunRoom` drop their explicit `<E>` — the event type now flows from the route map. The only residual erasure is one re-narrow inside the heterogeneous shared-socket registry (commented). |
| `request.json() as RunRoomEvent/ProjectRoomEvent` (both `.ws.ts`)                       | `schema.safeParse(...)` → 400 on failure (parse, don't assert)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `rows as RunListRowData[]` ×4 (`project-feed.ts`)                                       | reducer is `readonly`-in/`readonly`-out; `useProjectRoom` holds `readonly RunListRowData[]`                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Best practice

- **HIGH — trimmed the run-room wire payload.** `broadcastRunUpdate` shipped the
  whole ingest batch's `changedTests` **including `errorMessage`/`errorStack`**
  (capped at ~64 KiB + ~128 KiB _each_), which the live list never renders and
  which could blow the WS frame ceiling — and Void's `broadcast` has no
  per-socket try/catch, so one oversized `send` drops the **entire** event
  (summary included) for every viewer. `RunProgressTest` (`events.ts`) now carries
  only the rendered fields (status/title/file/projectName/duration/retryCount);
  error text is loaded from D1 on the test-detail page. `buildChangedTests` and
  `run-results-page` stopped selecting/mapping the columns accordingly. Verified
  no live consumer reads error text (`run-progress.tsx` renders none; the list
  popover + flaky page + test-detail use separate D1 loaders).
- **Reconnect storm.** `useRoom` now passes `reconnectDelayMs: 3000` — Void's
  VoidSocket re-dials on every non-user close at a flat 1s with no backoff/cap,
  so an expired-session tab (403 on upgrade) would re-dial once a second forever.
  3s softens it. (Void exposes only a flat delay; the auth-expiry reconnect can't
  be fully stopped from the client — documented limitation.)

## Security

- **Dedicated internal secret — generated at build time.** The DO-to-DO
  room-publish gate no longer reuses the session-signing secret. `vite.config.ts`
  bakes a per-build random into the SERVER bundle as `__WRIGHTFUL_INTERNAL_SECRET__`
  (a `define`, applied outside test); since the publisher worker and the room DOs
  are one Cloudflare deployment / one bundle, both read the identical value — so
  it's **zero-config, decoupled from `BETTER_AUTH_SECRET`, and auto-rotates per
  deploy**. Precedence (`resolveInternalSecret`): an explicit
  `REALTIME_INTERNAL_SECRET` env (optional override / pin) → the build-time
  `BUILT_IN_SECRET`. It **deliberately does NOT fall back to `BETTER_AUTH_SECRET`**
  — the internal-RPC capability stays fully decoupled from the session secret. If
  neither is available it **throws** (a loud misconfig guard; never fires in a
  real worker, since the build always injects `BUILT_IN_SECRET` — the `define` is
  omitted only under test, where callers supply the env override or assert the
  throw). Verified in the build output: `BUILT_IN_SECRET = "<random>"` in
  `dist/ssr/assets/room-server-*.js` (the resolver references no auth secret),
  and the client bundle contains neither the secret nor the `x-wrightful-internal`
  header (room-server is server-only).
- **Constant-time compare.** The `onRequest` secret check uses
  `timingSafeEqualBytes` (the project's existing primitive) via the shared
  `isInternalRequest`, not a short-circuiting `!==`.
- **Connection cap.** `onBeforeConnect` rejects with 429 once a room holds
  `ROOM_CONNECTION_CAP` (256) connections (`roomAtCapacity`) — `void/ws` has no
  built-in cap; this restores the old SSE `maxSubscriptionsPerTopic: 256` backstop.
- **Body validation.** The `z.custom<T>(() => true)` permissive predicates became
  real guards (`changedTests` must be an array — guarding the reducer's `for…of`;
  `run` must be an object with a string id; `summary` is a full `z.object`), so a
  malformed internal POST is 400'd before fan-out instead of broadcast.

New shared module `src/realtime/room-server.ts` houses the pure helpers
(`resolveInternalSecret`, `isInternalRequest`, `roomAtCapacity`,
`INTERNAL_HEADER`, `ROOM_CONNECTION_CAP`).

## Test coverage (the review found the publish path + room handlers untested)

- `room-server.test.ts` — secret resolution precedence, constant-time check
  (correct / wrong-equal-length / wrong-length / missing), lazy connection cap.
- `events-schema.test.ts` — the new guards: non-array `changedTests` rejected,
  malformed summary rejected, run-created without an object/id rejected, ping ok.
- `publish.test.ts` — the single server→room path: binding name →
  `buildWebSocketInstanceId` → `idFromName`/`get` → POST with the dedicated secret
  header + JSON body; non-ok → `logger.warn`; throw / stale binding → swallowed
  `logger.error` (never throws — the D1 write is already committed).
- `ws-rooms.test.ts` — the room handlers (sole forged-broadcast + connect-time
  isolation gates): `onRequest` 405/403(no secret)/403(wrong secret)/400(bad
  body)/200(+broadcast); `onBeforeConnect` 429-at-capacity / 403-on-deny /
  allow / null-userId / correct `run:`/`project:` topic construction.
- Plus a `project-feed` unknown-event defensive no-op.

### E2E — `packages/e2e/tests-dashboard/realtime.spec.ts` (canonical suite)

**Correction (important):** the canonical dashboard E2E suite is
`packages/e2e/tests-dashboard/` (`@wrightful/e2e`, self-booting on :5189 via
global-setup, pre-authed via `storageState`, with page-object + `ctx` fixtures) —
NOT `apps/dashboard/e2e/`. An earlier session created an ad-hoc, manually-served
`apps/dashboard/e2e/realtime.spec.ts` duplicate and strengthened THAT, while the
real `packages/e2e/tests-dashboard/realtime.spec.ts` was left **broken by the SSE
deletion** (it `waitForResponse`d the now-gone `/live`). A review agent flagged
this; it was wrongly dismissed as a hallucination (checked `apps/dashboard/tests-
dashboard/` — wrong package). Now resolved: the canonical spec is rewritten for
`void/ws` + the lifecycle coverage below, and the `apps/dashboard/e2e/` duplicate

- its `test:realtime` script are deleted.

Coverage (run via `pnpm --filter @wrightful/e2e test:dashboard`):

- **run detail:** per-test list streams; the published summary drives the header
  **OutcomeBar** live (`/2 passed, 1 failed/` via its `role=img` aria-label); the
  **Tests-tab count is live** (`RunTestCountLive`); the sticky-header status glyph
  is `running` while streaming and **flips to `failed` on completion** — the exact
  bug reported this session.
- **runs list:** an in-flight run streams its counts and its row status glyph
  **flips `running`→`failed` on completion**; a run opened after load appears +
  streams live.

Status glyphs asserted via `role=img` + `aria-label` with `exact: true` (the
OutcomeBar is also `role=img`, so substring matching would collide).

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` → clean.
- `pnpm --filter @wrightful/dashboard test` → **663 passed / 61 files** (+37 new).
- `pnpm check:fix` → **0 errors** (warnings 92 → 87; the cast removals).
- `pnpm --filter @wrightful/dashboard build` (`vp build`) → succeeds.
- `pnpm --filter @wrightful/e2e test:dashboard realtime` → covers streaming +
  completion on the list and run-detail (canonical suite, self-booting on :5189).

## Remaining / follow-ups

- The internal secret is now build-time-generated (no prod secret to set). One
  consequence: it rotates each deploy, so during a rolling deploy an in-flight
  publish from the old version to a new-version room can 403 — non-fatal (logged,
  the event is dropped; the D1 write already succeeded), self-heals once rollover
  completes. Set `REALTIME_INTERNAL_SECRET` explicitly only if you need a pinned,
  non-rotating value.
- Low-value: a test for `authorizeTopicSubscription`'s DEFAULT (real-D1) lookup
  binding (every current test injects a fake lookup).
- Auth is connect-time only (no mid-socket revocation) — acceptable for now;
  noted in ADR 0001.
