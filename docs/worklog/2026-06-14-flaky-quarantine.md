# 2026-06-14 — Flaky test quarantine workflow (roadmap 2.2)

## What changed

Turned flaky **detection** into **action**: a per-project quarantine list keyed
by the stable `testId`, which the reporter pulls at `onBegin` and uses to demote
known-flaky failures on the wire so they stop reddening runs / failing CI while a
test is being stabilised. Owners manage the list from the flaky + tests-catalog
pages.

End-to-end:

1. **Schema** — new `quarantinedTests` table (`db/schema.ts`), modelled on
   `testTags` (+ `monitors` for `createdBy`/`createdAt` conventions): `id` ULID
   PK, `projectId` FK → projects `onDelete: cascade`, `testId`, nullable
   `reason`, `mode` `$type<"skip"|"soft">` default `"skip"`, `createdBy`
   (logical user FK, no `.references()`), `createdAt`. Unique
   `(projectId, testId)` + `index(projectId, createdAt)`. One additive migration
   generated via `void db generate` (no journal/snapshot hand-edits).

2. **Repo** (`src/lib/quarantine-repo.ts`) — mirrors `monitors-repo`: branded
   `TenantScope`, Drizzle from `void/db`, every query scoped by `projectId`
   (logical tenancy, no DO boundary). `listQuarantine` (reporter pull),
   `quarantineTest` (upsert via `onConflictDoUpdate` on the unique pair so
   re-quarantining updates mode/reason), `unquarantineTest` (scoped delete),
   `loadQuarantineByTestId` (page-badge join, mirrors `loadTagsByTestId`).

3. **Bearer ingest route** (`routes/api/runs/quarantine.ts`) — `GET`. Already
   matched by `RUN_INGEST_RE` so it's auto-Bearer-gated by
   `middleware/02.api-auth.ts` (no middleware change). `tenantScopeForApiKey` →
   `{ tests: [{ testId, mode, reason }] }`.

4. **Session-authed owner-gated mutation** (`routes/api/t/[teamSlug]/p/
[projectSlug]/quarantine.ts`) — `POST` discriminating on an `intent` field
   (`quarantine` / `unquarantine`), reused by BOTH pages (one handler, not
   duplicated page actions). Owner gating via the new
   `resolveOwnerTenantApiScope` (added to `src/lib/tenant-api-scope.ts`, the
   session-API sibling of `requireOwnerTenantContext`). Bodies validated with
   Zod (`src/lib/quarantine-schemas.ts`). Redirects back to the originating page
   (`redirectTo`, validated via `safeNextPath`).

5. **UI** — a shared `QuarantineCell` (`src/components/quarantine-cell.tsx`):
   a `ui/badge` ("Quarantined", `variant="warning"`) when quarantined, plus an
   owner-only `<form>` POST control (no per-row island; works without JS). Wired
   into both `flaky.{server.ts,tsx}` (+ `FlakyTestRow`) and `tests.{server.ts,
tsx}` — each loader adds `loadQuarantineByTestId` into its existing
   `Promise.all`, threads a `quarantinedByTestId` map + `canManageQuarantine`
   (`project.role === "owner"`) + `fullPath` (the redirect target) into props.

6. **Reporter** — new `quarantine.ts`: `fetchQuarantine(client)` (indexes the
   list by testId via a new tolerant `StreamClient.fetchQuarantine` that returns
   `[]` on 404 / network / parse error so quarantine NEVER breaks a run), and a
   pure `applyQuarantine(payload, map)` (demotes a quarantined
   failed/timedout/flaky to `skipped` + appends a `{ type: "quarantined" }`
   annotation; leaves non-quarantined / passed untouched, same reference).
   `index.ts onBegin` fires the fetch in parallel with `openRun` (stored as
   `quarantinePromise`, awaited in `enqueueDone` before building each payload,
   like the batcher awaits `openPromise`). Demotion happens before the per-status
   tally so counts reflect the demoted status.

## Details

| Area           | File(s)                                                                                                                                         | Note                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Schema         | `apps/dashboard/db/schema.ts`                                                                                                                   | `quarantinedTests` table + `QuarantinedTest` type alias                    |
| Migration      | `db/migrations/20260613225946_motionless_the_initiative.sql`                                                                                    | additive `CREATE TABLE` + 2 indexes                                        |
| Repo           | `src/lib/quarantine-repo.ts`                                                                                                                    | new                                                                        |
| Mutation Zod   | `src/lib/quarantine-schemas.ts`                                                                                                                 | new (`QuarantineTestSchema`, `UnquarantineTestSchema`, `QUARANTINE_MODES`) |
| Wire Zod       | `src/lib/schemas.ts`                                                                                                                            | `QuarantineEntrySchema` + `QuarantineResponseSchema`                       |
| Owner scope    | `src/lib/tenant-api-scope.ts`                                                                                                                   | `resolveOwnerTenantApiScope`                                               |
| Bearer route   | `routes/api/runs/quarantine.ts`                                                                                                                 | new (`GET`)                                                                |
| Mutation route | `routes/api/t/[teamSlug]/p/[projectSlug]/quarantine.ts`                                                                                         | new (`POST`, owner-gated)                                                  |
| UI             | `src/components/quarantine-cell.tsx`, `src/components/flaky-test-row.tsx`, `pages/.../flaky.{server.ts,tsx}`, `pages/.../tests.{server.ts,tsx}` | badge + owner control                                                      |
| Reporter       | `packages/reporter/src/{quarantine.ts,client.ts,index.ts,types.ts}`                                                                             | fetch + demote on the wire                                                 |
| Tests          | `src/__tests__/quarantine-repo.test.ts`, `packages/reporter/src/__tests__/quarantine.test.ts`, extended `contract.test.ts`                      |                                                                            |

## Decisions

- **Mutation = dedicated `/api/t/*` route, not page actions.** The flaky and
  tests pages are two separate Inertia pages needing the same mutation; a shared
  POST route (intent-discriminated) avoids duplicating the logic as `actions` on
  each page. The existing `/api/t/*` routes were all member-level GET readers, so
  a new owner-gated resolver (`resolveOwnerTenantApiScope`) was added rather than
  bending `resolveTenantApiScope`.
- **Owner detection** comes from `project.role === "owner"` — the same role the
  page tenant context already carries (`requireTenantContext` →
  `ResolvedActiveProject.role`), surfaced as `canManageQuarantine` in props.
  Non-owners see the badge but no control; the server route 404s a non-owner
  (leak-shaped, mirroring `requireOwnerTenantContext`).
- **v1 enforcement = demote on the wire.** A Playwright reporter is observe-only
  (can't `test.skip()` execution), so the closest enforcement is reporting a
  quarantined failure as `skipped`. `mode: "soft"` is reserved (not yet enforced
  differently). True skip-execution via a `test.extend` fixture is a documented
  follow-up.
- **Demotable statuses** = `failed | timedout | flaky` (everything that reddens a
  run / fails CI), not just hard `failed`.

## Adversarial review + fixes

A 6-dimension adversarial review (tenant-isolation, wire-contract,
reporter-robustness, schema-migration, UI, data-logic; every raised finding
re-verified by an independent skeptic) confirmed **4 of 16** raised issues real —
all UI / test-quality polish; the security, wire-contract, reporter, and
migration dimensions came back clean (the core is sound). Fixes:

- **`quarantineError` was a dead error channel (medium).** The mutation route
  redirects back with `?quarantineError=…` on a Zod / conflict failure, but no
  page read it — a failed quarantine looked like a silent no-op. Now both
  loaders read `url.searchParams.get("quarantineError")` into props and both
  pages render it via the standard `ui/alert` (`variant="error"`) banner, matching
  the `general.tsx` / `members.tsx` redirect-error precedent.
- **Hand-rolled `<button>` → `ui/button` (low).** `QuarantineCell` now uses the
  `Button` wrapper (`size="xs"`, `variant="outline"`) and collapses the two
  near-identical quarantine/unquarantine forms into one, so the control inherits
  the design-system focus-visible ring / hover / disabled tokens like every other
  POST-form button.
- **Per-row accessible labels (low).** The buttons were all named just
  "Quarantine"/"Release" with no per-test context, and the quarantine reason rode
  only on `title` (not reliably announced). `QuarantineCell` now takes the test
  `title` (threaded from both call sites) to build
  `aria-label="Quarantine <test>"` / `"Release <test> from quarantine"`, and the
  badge carries the reason on `aria-label`.
- **Upsert test pinned to the real columns (low).** `quarantine-repo.test.ts`
  asserted only `cfg.target.toHaveLength(2)`; now asserts
  `target.map(c => c.name) === ["projectId","testId"]` and the re-stamped
  `set.createdBy`/`set.createdAt`, so a wrong-but-2-element conflict target can't
  pass.

## Verification

Run from each workspace (the repo-root `vp test run` does NOT apply the
dashboard's `@/` alias config — it must be run from inside the workspace):

- `void prepare` (dashboard) — codegen picked up the new route + schema. ✓
- `void db generate` (dashboard) — exactly one additive migration:
  `CREATE TABLE quarantinedTests` + the unique `(projectId,testId)` and
  `(projectId,createdAt)` indexes. No destructive statements. ✓
- `tsgo --noEmit` (dashboard + reporter) — clean (exit 0). ✓
- `vp test run` in `apps/dashboard` — **87 files, 906 tests passed.** ✓
- `vp test run` in `packages/reporter` — **15 files, 248 tests passed** (incl. the
  new `quarantine.test.ts` and the extended contract canary). ✓
- `vp check` — **0 errors**, 80 pre-existing `no-unsafe-type-assertion` warnings
  in `packages/e2e` (untouched). ✓
