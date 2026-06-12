# 2026-06-12 — HTTP (uptime) monitoring (Phases 1–3)

## What changed

Added a second monitor type — `http` ("uptime monitor") — alongside the existing
Playwright `browser` monitors, implementing Phases 1–3 of the uptime-monitoring
plan. An HTTP monitor is authored via a form (URL, frequency, thresholds,
assertions), runs as a plain `fetch()` from a new dedicated queue consumer (no
sandbox container, no Docker, no synthetic API key, no `runs` row), and stores
its result inline on `monitorExecutions`. It reuses the existing scheduler, claim
CAS, realtime broadcast, and list/detail chrome unchanged. The full as-built
design is in `docs/design/uptime-monitoring.md`.

Phases 4 (sub-minute scheduling), 5 (in-executor retries), and 6 (alerting) are
deferred per the plan and remain documented as the roadmap.

### Open questions resolved (plan §15)

- Dedicated `queues/uptime.ts` (not shared with `monitors`). ✅
- `degraded` counts as UP in uptime % (D6 — behavior change to `uptimeFromExecutions`). ✅
- Sub-minute is fast-follow (Phase 4): schema accepts the full preset list for
  data-compatibility; v1 UI exposes only the `>= 60s` subset. ✅
- Per-project HTTP cap = 50, via a **separate** env key + type-scoped count (the
  existing 25 cap is browser-only). ✅
- Create flow = type-chooser cards at `/monitors/new`. ✅

## Details

### New files

| File                                                                                                                             | Purpose                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `src/lib/monitors/http/url-policy.ts`                                                                                            | Pure SSRF/scheme/credential URL guard.            |
| `src/lib/monitors/http/assertions.ts`                                                                                            | Pure assertion evaluator + JSONPath subset.       |
| `src/lib/monitors/http/http-run.ts`                                                                                              | Pure DI check lifecycle (`runHttpCheck`).         |
| `src/lib/monitors/http/http-executor.ts`                                                                                         | Thin `MonitorExecutor` adapter (real fetch).      |
| `src/lib/monitors/http/uptime-analytics.ts`                                                                                      | Detail-page response-time + uptime SQL.           |
| `queues/uptime.ts`                                                                                                               | Dedicated batched, container-free consumer.       |
| `pages/.../monitors/http-monitor-form.tsx`                                                                                       | HTTP create/edit form + assertion builder island. |
| `db/migrations/20260612090517_dizzy_praxagora.sql`                                                                               | Adds `statusCode` + `resultDetail`.               |
| `src/lib/monitors/http/__tests__/{url-policy,assertions,http-run}.test.ts`, `src/lib/monitors/__tests__/monitor-schemas.test.ts` | Unit tests.                                       |
| `packages/e2e/tests-dashboard/uptime-monitors.spec.ts`                                                                           | E2E smoke.                                        |

### Schema / data

- `monitorExecutions` gained nullable `statusCode` (integer) and `resultDetail`
  (text JSON). Additive, non-destructive migration via `void db generate`.
- `ExecutionResult` gained `statusCode` + `resultDetail`; both browser executors
  (`sandbox-run.ts`, `stub-executor.ts`) and the infra-error builders now return
  `null` for them. `recordExecutionResult` persists them (`resultDetail`
  JSON-stringified).
- `MonitorExecutionRow` (realtime) gained `durationMs` + `statusCode`; the
  `monitorResultEvent` construction and the list loader projection carry them.

### Config / validation

- `monitor-schemas.ts`: `CreateMonitorSchema` is now a `discriminatedUnion` on
  `type` (`CreateBrowserMonitorSchema` | `CreateHttpMonitorSchema`); per-type
  partial update schemas (a union can't be `.partial()`-ed); the
  `HttpMonitorConfigSchema` / `AssertionSchema` pair (per-source
  allowed-comparison + property-required `superRefine`); `HTTP_INTERVAL_PRESETS`
  (full) with the `HTTP_INTERVAL_PRESETS_V1` `>=60s` subset;
  `parseHttpMonitorConfig` (shared read-path parser).
- `monitors-repo.ts`: `createMonitor`/`updateMonitor` write `source` (browser) /
  `config` (http); `countMonitors(scope, type?)` gained a type filter.

### Pipeline / routing

- `executor-registry.ts`: `resolveExecutor` is type-dispatching (http →
  `HttpExecutor`, else stub/sandbox).
- `scheduler.ts`: `sweepDueMonitors`'s `enqueue` callback now receives the
  monitor row (jobs stay IDs-only); `crons/sweep-monitors.ts` routes by
  `monitor.type` to `queues.uptime` vs `queues.monitors`.

### UI

- `monitors/[monitorId]/index.{server.ts,tsx}`: create-mode type chooser + per-type
  form; type-dispatched actions (type-scoped caps; immutable `type`); detail loader
  computes http config + time-based uptime + hourly response-time buckets; detail
  page renders the http config summary, status-code/duration/expandable-assertion
  exec rows (no "View run"), uptime stat cards, and the response-time chart.
- `monitors-ui.shared.ts`: `uptimeFromExecutions` counts `degraded` as up;
  `HTTP_INTERVAL_OPTIONS`; `monitorTypeLabel`.
- `monitor-status.tsx`: `MonTypeGlyph` (beaker vs globe); `monitors-list.client.tsx`
  uses it; list subtitle shows a plain monitor count (two caps make "of N"
  ambiguous).

### Env

- `WRIGHTFUL_HTTP_MONITOR_MAX_PER_PROJECT` (default 50) and
  `WRIGHTFUL_HTTP_CHECK_MAX_BODY_BYTES` (default 262144).

### Local dev seed

- `scripts/seed-demo.mjs` (`setup:local`) now seeds a mix of both types: the
  existing 4 browser checks plus 2 http (uptime) checks (one passing, one with
  an assertion that fails against its target — the http analogue of the browser
  `FORCE_FAIL` demo). http targets must be public URLs (`url-policy` rejects
  `localhost`), so the demo points at `example.com`. There's no http stub — a
  seeded uptime check does a real `fetch` once the sweep fires.

## Verification

- `pnpm install` (fresh worktree) + `void prepare` + `void db generate` (migration
  reviewed: two additive nullable columns).
- `pnpm check` (root) — **0 errors** (format + lint + type-aware typecheck);
  remaining warnings are pre-existing.
- `pnpm test` — dashboard **866 passed** (was 800; +66 new across url-policy,
  assertions, http-run, monitor-schemas, monitor-form-parse, and updated
  executor/monitor-feed fixtures), reporter **233 passed**.
- E2E (`uptime-monitors.spec.ts`) written; requires a booted dashboard to run
  (not run here — the dev server is user-driven).
- Adversarial multi-agent review run over the diff (5 dimensions × adversarial
  verification); findings triaged and addressed.

## Follow-up: second review pass (validated + fixed)

A further 15-finding review (Sonnet) was validated finding-by-finding against the
code. 6 were applied; the rest were either incorrect, deliberate, or cosmetic.

**Applied:**

- **Bug — `degradedResponseTimeMs = 0` marked every check `degraded`.** Schema
  allowed `.min(0)`, so `totalMs > 0` (`http-run.ts`) was always true. Changed to
  `.min(1)` (`monitor-schemas.ts`) + `min={1}` on the form input; regression test
  in `monitor-schemas.test.ts`.
- **Security — IPv6 `fe80::/10` link-local gap.** `isBlockedIpv6` matched the
  prefix `fe80` (only `fe80::`), missing `fe81::`–`fe8f::`. Changed to `fe8`;
  regression cases added to `url-policy.test.ts`. (Defense-in-depth — Workers
  egress already blocks these.)
- **Robustness — cross-type contamination backstop.** `updateMonitor` now gates
  `source` (browser-only) / `config` (http-only) by the stored `monitor.type`, so
  a direct/future caller can't write the wrong type's payload field. The action
  dispatch already prevented this in the normal flow.
- **Efficiency — redundant SELECT on edit.** `updateMonitor` accepts the
  already-loaded monitor from the edit action (skips a re-fetch).
- **Efficiency — serial loader queries.** `httpUptimeWindows` +
  `httpResponseTimeBuckets` now run via `Promise.all` in the detail loader.
- **Efficiency — `readBodyCapped` double allocation.** Replaced the chunk-array +
  second-buffer copy with incremental `TextDecoder` streaming (no retained chunks,
  no over-allocation; body cap behavior unchanged, covered by existing tests).

**Not applied (validated as not actionable):** opaque-redirect "SSRF" (no target
is fetched in manual-redirect mode — re-check correctly only fires for _followed_
redirects); missing `statusCode` index (the `(monitorId, createdAt)` index already
serves the bounded per-monitor window query); `countMonitors` `teamId` filter (the
monitors repo scopes by `projectId` alone by design — consistent across all its
reads). Serial uptime-batch consumer left as-is (documented/deliberate: worst-case
~300s << 15-min invocation bound). Cosmetic nits (unescaped `actual` in an error
string, UTC-only chart labels, unknown-`formType` coercion, JSON-path escaped
quotes) deferred.

**Verification:** `vp test run` over the monitors suite — **119 passed** (incl.
new regression cases); `vp check` — **0 errors** (pre-existing e2e warnings only).
