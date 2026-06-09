# 2026-06-06 — Runs list live updates (diagnosing "results aren't streaming")

## What changed

Diagnosed a report that "results aren't streaming in real-time — I see a run in
progress, refresh updates it, but the realtime element isn't working at all,"
and made the project **runs list** update live: a streaming run's row fills in /
flips status without a reload, and a **brand-new run appears on its own** (no
refresh) while it streams.

The headline diagnostic finding: the realtime pipeline was **not broken**. The
run-_detail_ page (`<RunSummaryLive>` tiles + `<RunProgress>` per-test list)
already subscribed and streamed correctly in dev (proven empirically). The
runs-_list_ page rendered a static load-time query with **no subscription**, so
runs there only changed on reload.

### Final design — project-wide live feed

The list subscribes (one `void/live` connection) to a new project topic
`project:<projectId>` carrying run lifecycle:

- `run-created` — a run just opened → the list prepends its row;
- `run-progress` — a run's aggregate advanced or it finalized → the list updates
  that row's status / counts / duration in place.

Published from the same ingest writes that already drove the per-run
`run:<runId>` topic (which still powers the detail page). New runs prepend only
on the **default first page** (no filters), so a filtered/paginated view isn't
injected with rows that don't match it.

## Diagnosis trail (why it looked broken but wasn't)

Ruled out with direct evidence, not static reasoning:

| Hypothesis                                                               | Verdict          | Evidence                                                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunProgress` missing `"use client"` breaks hydration                    | ✗                | Void ignores `"use client"`; islands are `*.island.tsx` + `import … with { island }` (zero in app). Run-detail is a regular page → fully hydrated.                     |
| `live.publish` throws in dev (missing `VOID_LIVE` binding) → ingest 500s | ✗                | `POST /api/runs`, `/results`, `/complete` return 200/201; SSE frames arrive. (A background static-analysis pass flagged this high-confidence — empirics disproved it.) |
| SSE buffered by the dev server                                           | ✗                | `eventStream` sets `X-Accel-Buffering: no` over a `TransformStream`; an instrumented browser saw `EventSource` open + `message` frames.                                |
| Subscribe rejected (auth/membership)                                     | ✗                | Subscribe `POST /live` returns `accepted: true, ok: true`.                                                                                                             |
| Runs-list page doesn't subscribe                                         | ✓ **root cause** | Only the two detail-page components used `useRunProgress`.                                                                                                             |

### The fix evolved (and a regression to learn from)

1. First cut: each in-flight row got its own `useRunProgress` → **one
   `EventSource` per row**. With several `running` rows this exhausted the
   browser's ~6 HTTP/1.1 connections (dev Vite is HTTP/1.1), and **a refresh
   hung indefinitely** — the new document request deadlocked waiting for a
   connection slot the open SSE streams wouldn't release.
2. Reworked to one shared connection multiplexing all subscriptions.
3. That still required a refresh for a run created _after_ load (the list query
   is load-time) — which is exactly the `seed:stream` workflow — so the final
   design is the **project feed**: one subscription that also learns about new
   runs (`run-created`) and prepends them live.

## Isolation (multiplexing does NOT merge tenants)

- Each run is its own **topic DO** (`run:<id>`); the project feed is its own
  **topic DO** (`project:<id>`). Publish for one project only touches its topic.
- One **connection DO** (per `connectLiveStream`) holds one viewer's SSE stream;
  it only delivers topics that connection successfully subscribed to.
- Every subscribe is authorized **individually** by
  `authorizeTopicSubscription` — `run:<id>` → owning team membership;
  `project:<id>` → owning team membership (new `projects ⋈ memberships` lookup).
  Unit-tested for both topic types incl. cross-team denial.
- No run data lives in any DO — it's all in D1, scoped by `projectId`.

## Why the feed wasn't visible locally — `seed:stream` targeting

After the feed shipped, live updates still didn't show when driving data with
`pnpm seed:stream`, while the e2e (which drives `:5173` directly) passed. Cause:
`seed:stream` targeted `seed.url` from `.env.seed.json` — the **dynamic port
`setup:local` spun up a throwaway dev server on, then killed** (e.g. `:54709`) —
not the `:5173` the developer actually runs (`vite strictPort`). So the reporter
streamed to a **different instance** (or a stray left listening on that port):
shared local D1 → the run appeared on refresh, but the live publish hit that
instance's Durable Objects, never the `:5173` page being watched. Several stray
dynamic-port instances had accumulated from prior `setup:local`/`seed:stream`
runs, which masked it further.

Fix: `seed:stream` now targets `http://localhost:5173` by default (the fixed
dev port), keeping the `.env.seed.json` api key + slugs; `WRIGHTFUL_URL` still
overrides. Verified end-to-end — a browser on `:5173` saw `seed:stream`'s run
appear and stream 5 updates with no reload.

## Notes for future work

- `void/live` delivers over **SSE** (`EventSource`), not WebSockets. (Stale
  "wss://" comments in `routes/live.ts` were corrected.)
- `void/live` has **no event replay** — `publish` reaches only current
  subscribers; a result streamed before a page subscribes is lost (SSR seed
  covers the past). This shaped the e2e (subscribe before streaming).
- The project feed adds **+1 publish per ingest write** (run + project topics).
  Fine at current scale; the project topic is hot if a project has many list
  viewers.
- The run-_detail_ page still opens 2 connections (`RunSummaryLive` +
  `RunProgress`); under the limit, could share later.

## Details

| File                                                                                           | Change                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/live.ts`                                                                                  | Added `RunListRowData`, `ProjectFeedEvent`, `publishProjectUpdate("project:<id>")`.                                                                                                    |
| `src/lib/ingest.ts`                                                                            | Publish `run-created` from `openRun`; `run-progress` from `appendRunResults` + `reconcileAndBroadcast` (complete / stale-finalize).                                                    |
| `src/lib/authz.ts`                                                                             | `authorizeTopicSubscription` now also handles `project:<id>` via a `projects ⋈ memberships` lookup (4th param).                                                                        |
| `src/lib/live-client.ts`                                                                       | New `useProjectRunFeed(projectId, initialRows, {acceptNewRuns})` — one subscription, prepends `run-created`, updates `run-progress`. (Replaced the interim `useInFlightRunSummaries`.) |
| `src/components/run-list-row.tsx`                                                              | Presentational `RunListRow` + row pills, extracted from the page; typed on `RunListRowData`.                                                                                           |
| `pages/t/[teamSlug]/p/[projectSlug]/index.tsx`                                                 | Renders `useProjectRunFeed` rows; `#N` + footer account for live-prepended runs.                                                                                                       |
| `routes/live.ts`                                                                               | Comment fix: "wss://" → SSE (tidy-up agent).                                                                                                                                           |
| `e2e/{playwright.config.ts,realtime.spec.ts}`                                                  | New Playwright realtime suite (4 tests).                                                                                                                                               |
| `apps/dashboard/package.json`                                                                  | `test:realtime` script.                                                                                                                                                                |
| `src/__tests__/{authorize-topic-subscription,ingest-pipeline,reconcile-and-broadcast}.test.ts` | Project-topic auth cases; assert the new project publishes.                                                                                                                            |

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` → clean.
- `pnpm check:fix` → 0 errors.
- `pnpm --filter @wrightful/dashboard test` → **609 passed / 54 files**.
- `pnpm --filter @wrightful/dashboard test:realtime` → **4 passed**:
  - runs list fills in an in-flight run without a reload;
  - run detail streams the per-test list without a reload;
  - runs list shares ONE connection across many in-flight rows (3 rows → ≤2 `EventSource`s);
  - **a run started AFTER load appears + streams on the default list** (the new behavior).
- Manual: instrumented browser confirmed `EventSource` open + `accepted` subscribe
  - `message` frames + rows updating/appearing live on the unfiltered list (1 connection).

The realtime e2e needs `pnpm dev` up + a seeded demo (`pnpm setup:local`); it
skips cleanly when `.env.seed.json` / `WRIGHTFUL_TOKEN` is absent.
