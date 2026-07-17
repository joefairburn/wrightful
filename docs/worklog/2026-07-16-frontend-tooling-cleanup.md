# 2026-07-16 — Frontend cleanup, tooling, and missing tests

A grab-bag of low-risk cleanups plus two missing unit suites. No schema,
protocol, or auth-behavior changes.

## Dead-component finding: NOT dead (no deletions)

The review flagged three components as having zero non-test importers. Re-grep
(import path + JSX symbol, immediately before any delete) shows all three are
**live**, so none were deleted:

- `src/components/status-badge.tsx` — imported by
  `runs/[runId]/tests/[testResultId]/index.tsx` and `tests/[testId]/index.tsx`.
- `src/components/attempt-tabs.tsx` (`AttemptTabsBar` / `AttemptPanel`) —
  imported by `runs/[runId]/tests/[testResultId]/index.tsx`.
- `src/components/sparkline.tsx` (`Sparkline`) — imported by
  `src/components/flaky-test-row.tsx`, which `flaky.tsx` renders. (Distinct from
  the live `analytics/metric-sparkline.tsx` `MetricSparkline`.)

The original "zero importers" finding was incorrect; kept all three.

## Loader boilerplate helper

New `src/lib/page-loader.ts` with two tiny helpers:

- `pageProjectFields(project)` — the `{ id, teamId, slug, name, teamSlug }`
  projection every tenant page loader returns.
- `deferredNoStore(c)` — sets `Cache-Control: private, no-store` and owns the
  "deferred loaders must not be stored" rationale in one place.

Applied (behavior identical) in the six deferred analytics loaders:
`insights/index.server.ts`, `insights/run-duration.server.ts`,
`insights/slowest-tests.server.ts`, `insights/suite-size.server.ts`,
`tests.server.ts`, `flaky.server.ts`.

## int8 coercion fix (flaky loader)

`flaky.server.ts` `loadRecentFailures` selected `tr."createdAt"` (int8) via the
raw `runRows` path typed as `number`. node-postgres returns int8 as a **string**
(pglite returns a number, hiding it), so `createdAt` rendered correctly only by
accidental coercion in `formatRelativeTime`. Fixed per the repo cast convention
(`cast(… as double precision)`, matching `monitors-repo.ts` and the
`numAggExpr`/`intAggExpr` idiom) so the value is a real JS number on both
drivers.

## className cn() fix

`flaky.tsx` skeleton used a string-interpolated `className={\`h-[13px] ${valueW}\`}`;
converted to `cn("h-[13px]", valueW)`(added the`@/lib/cn` import).

## `pnpm deploy` shadowing fix

pnpm has a built-in `deploy` command that shadows a root `deploy` **script**, so
the documented `pnpm deploy` silently did not run `void deploy` (only
`pnpm run deploy` worked). Renamed the root script to `deploy:void` and updated
every doc reference: `AGENTS.md` (Commands), `SELF-HOSTING.md`, `docs/PRD.md`.
The `apps/dashboard` `deploy` script is unchanged — it is invoked via
`pnpm --filter … run deploy` (explicit `run`), so it was never shadowed.

## E2E fixture hardening (`packages/e2e/src/dashboard-fixture.ts`)

- **Teardown now awaits exit with SIGKILL escalation.** `teardown` was
  synchronous and only SIGTERM'd the preview process group. A wedged `workerd`
  could survive and hold the fixed port, failing the next run's
  `vp preview --strictPort`. New `killPreviewGroup()` sends SIGTERM, waits for
  the group to exit, escalates to SIGKILL after a timeout, and caps the total
  wait; all timers are `unref()`'d. `teardown` is now `async`; the three call
  sites (`vitest.globalSetup.ts`, `tests-dashboard/global-setup.ts`,
  `tests-dashboard/global-teardown.ts`) now `await` it, and the interface type
  is `() => Promise<void>`.
- **Concurrent-run guard strengthened.** The old "refuse if backup exists" guard
  only fired for the SAME `envBackupSuffix`, so a concurrent run of the OTHER
  suite went undetected — and both suites mutate the shared `.env.local` and run
  `void db reset`, making them mutually destructive. Added a shared, suffix-
  agnostic lock file (`apps/dashboard/.env.local.lock`), acquired before the
  `.env.local` mutation and released in teardown, plus a stray-backup scan that
  refuses on ANY `.env.local.*` sibling. CI stays safe (separate runners); this
  protects local devs running both suites at once.

### Deferred follow-up: external `playwright.dev` dependency

`packages/e2e/playwright.config.ts` sets `baseURL: "https://playwright.dev"` for
the demo suite that generates streamable test data feeding the dashboard e2e
harness. This makes a CI-gating suite depend on an external site's availability.
Fixing it means re-pointing the demo suite at a locally served target (a small
static fixture site or a vendored page set), which is a non-trivial rewrite with
its own maintenance surface. Left as a **recommended follow-up** rather than a
risky in-place change.

## Tests added

- `src/__tests__/tenant-context.workers.test.ts` (8 tests) —
  `requireTenantContext` returns a branded scope mirroring the auth-checked
  project ids/slugs, and 404s when no membership resolved an `activeProject`;
  `requireOwnerTenantContext` admits owners and denies member/viewer with **404
  (not 403)** — the leak-safe posture that never confirms the resource to a
  caller who can't act.
- `src/__tests__/pg-integration/project-teardown.test.ts` (6 tests) —
  `teardownProject` deletes ONLY the target `projects.id` (siblings on the same
  or another team survive), schedules the R2 sweep for exactly the destroyed
  `(teamId, projectId)` and only AFTER the row delete commits, and
  `scheduleProjectArtifactCleanup` swallows a failing sweep. Uses the pglite
  harness; note its DDL omits FK constraints, so this asserts the deletion
  **logic/scoping**, not the production `onDelete: "cascade"` (exercised by the
  migrated schema in e2e/deploy paths).

## Verification

- `vitest run src/__tests__/pg-integration/project-teardown.test.ts` — 6 passed.
- `vitest run -c vitest.workers.config.ts src/__tests__/tenant-context.workers.test.ts` — 8 passed.
- `pnpm --filter @wrightful/dashboard run typecheck` — clean for all files
  touched here (the two remaining errors, `invites.test.ts` and
  `usage-atomic.test.ts`, are in other in-flight workstreams, not this one).
- `packages/e2e` `tsgo --noEmit` — exit 0.
- Did NOT run the preview-booting e2e harness (`test:e2e` / `test:dashboard`) or
  repo-wide format/lint, per scope.
