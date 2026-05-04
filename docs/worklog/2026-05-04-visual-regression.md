# 2026-05-04 — Visual regression artifact pipeline

Added first-class support for Playwright visual snapshot failures
(`expect(page).toHaveScreenshot()` and image-mode `toMatchSnapshot()`).
Previously the three attachments Playwright emits on a snapshot failure
(`*-expected.png`, `*-actual.png`, `*-diff.png`) all landed as separate
"Screenshot" entries in the artifact rail with no visual context. They now
flow through the reporter as a single grouped `type: "visual"` artifact and
the test detail page renders a dedicated diff viewer.

## What changed

**Reporter** classifies snapshot-named PNGs after collecting them, then
group-validates per `(attempt, snapshotName)`: only when all three roles
(`expected`, `actual`, `diff`) appear in the same group does it promote the
rows to `type: "visual"` and attach `role` + `snapshotName` metadata. A
singleton or pair (e.g. a passing test that called
`testInfo.attach('foo-actual.png', …)` directly) falls back to the legacy
`screenshot` type — see `promoteSnapshotTriples` in
`packages/reporter/src/index.ts`.

**Wire format** is additive; no protocol bump. `ArtifactRequestSchema` now
accepts optional `role` (`expected`/`actual`/`diff`) + `snapshotName` fields,
plus `"visual"` as a new `type` enum value. A `superRefine` requires both
fields when `type === "visual"`. Old reporters keep working untouched; old
dashboards strip the unknown fields silently because the schema isn't
`.strict()`.

**Tenant DB** gains two nullable columns and a partial index in a new
`0002_visual_snapshots` migration (additive; `0000_init` and `0001_…` are
frozen on production DOs). The index is partial on
`snapshotName IS NOT NULL` so it stays small for non-visual rows.

**Dashboard UI** groups the three artifact rows server-side in
`test-detail.tsx` per `(attempt, snapshotName)` and emits a single
`ArtifactAction` carrying a `visualGroup` payload. The rail's
`RailArtifactButton` switches on `type === "visual"` and renders a new
`VisualDiffRailButton` that opens a `Dialog` with four tabs: `Diff`
(default), `Expected`, `Actual`, `Side-by-side`. The active tab is
persisted in `?vmode=` via nuqs so the user's preference is sticky across
multiple snapshots in the same view. Run-detail row chips filter visual
rows out — visual diffs are a detail-page concern.

## Details

### Reporter

| File                                                       | Change                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/reporter/src/attachments.ts`                     | New `parseSnapshotAttachment(filename)` and `SnapshotRole` export. `ArtifactType` extended with `"visual"`. `classifyAttachment()` itself is unchanged for PNGs (still returns `"screenshot"`); promotion happens in `index.ts`.                                          |
| `packages/reporter/src/index.ts`                           | New exported `promoteSnapshotTriples()` and `PreparedArtifact` (exported for test). `collectArtifacts()` calls the parser and `promoteSnapshotTriples()` after the per-result loop. `fireArtifactUploads()` forwards `role` + `snapshotName` into `ArtifactRegistration`. |
| `packages/reporter/src/types.ts`                           | `ArtifactRegistration` now has optional `role` + `snapshotName`.                                                                                                                                                                                                          |
| `packages/reporter/src/__tests__/attachments.test.ts`      | Tests for the new parser + a guard that confirms `classifyAttachment` still returns `screenshot` for snapshot-named PNGs.                                                                                                                                                 |
| `packages/reporter/src/__tests__/visual-snapshots.test.ts` | New file: 6 tests for `promoteSnapshotTriples` covering the complete-triple promotion, singleton/pair fallback, per-attempt grouping, multi-snapshot tests, and non-snapshot artifact pass-through.                                                                       |

### Dashboard

| File                                                           | Change                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dashboard/src/tenant/migrations.ts`                  | New `0002_visual_snapshots`: `ALTER TABLE artifacts ADD COLUMN role TEXT NULL`, same for `snapshotName`, plus a partial `CREATE INDEX … WHERE snapshotName IS NOT NULL`. `up()` returns the alter builders so rwsdk's `Database<typeof tenantMigrations>` type inference picks up the new columns. |
| `packages/dashboard/src/routes/api/schemas.ts`                 | `ArtifactRequestSchema` extended with `"visual"` enum + optional `role` + `snapshotName`, plus a `superRefine` that requires both for visual rows.                                                                                                                                                 |
| `packages/dashboard/src/routes/api/artifacts.ts`               | Persists `role` + `snapshotName` (nullable) on insert. `ARTIFACT_COLUMNS` bumped from 9 → 11; rows-per-statement recomputed (still ≤ 99 SQL params).                                                                                                                                               |
| `packages/dashboard/src/app/components/artifact-actions.tsx`   | New `VisualDiffFrame` + `VisualDiffGroup` interfaces; `ArtifactAction` gets optional `visualGroup`. `ArtifactButton` now has a no-op `case "visual"` so visual rows don't wrongly render as a copy-prompt chip in the run-detail row.                                                              |
| `packages/dashboard/src/lib/test-artifact-actions.ts`          | `loadFailingArtifactActions` filters `type !== "visual"` so the run-detail row stays clean.                                                                                                                                                                                                        |
| `packages/dashboard/src/app/pages/test-detail.tsx`             | Selects the new columns; `Artifact` interface extended; per-attempt loop builds visual groups via a new `toVisualAction(rows[])` helper that folds the triple into a single `ArtifactAction` carrying `visualGroup`. `TYPE_ORDER` extended to slot visual just below trace.                        |
| `packages/dashboard/src/app/components/visual-diff-dialog.tsx` | New file. `VisualDiffRailButton` (rail-styled trigger + dialog) and `VisualDiffViewer` (the inner Tabs). Reuses `Dialog`, `Tabs` underline variant, `Badge` error variant, lucide icons. Mode in `?vmode=` (nuqs). Hides tabs whose frame is missing (timeout case).                               |
| `packages/dashboard/src/app/components/artifacts-rail.tsx`     | `RailArtifactButton` switches `case "visual" → <VisualDiffRailButton />`.                                                                                                                                                                                                                          |

### Demo data — `pnpm setup:local` seeds a working visual diff

The Playwright suite that `upload-fixtures.mjs` drives moved from
`packages/dashboard/fixtures/playwright/` to
`packages/dashboard/scripts/seed/playwright/` so that all seed-related
files (`setup-local.mjs`, `seed-demo.mjs`, `upload-fixtures.mjs`,
`generator.mjs`, the Playwright suite) sit in one place. The empty
`packages/dashboard/fixtures/` dir is gone. The suite was also flattened:
the `tests/` subdirectory and `scripts/` subdirectory are now collapsed
into the suite root since "tests" was a misleading name (these specs are
seed code, not tests).

`scripts/seed/playwright/visual-regression.spec.ts` is the new visual
diff seeder, gated on `WRIGHTFUL_FIXTURE_FAILURES=1` (same pattern as
`flaky.spec.ts`). It renders a `setContent`-based 640×460 marketing
landing-page mock ("V2") and compares it against a committed baseline
("V1") at `visual-regression.spec.ts-snapshots/landing.png`. V1 → V2 has
three intentional, semantically meaningful deltas: a hero headline
("Build faster" → "Ship faster"), a CTA button colour change (blue →
green), and a Starter pricing change ($29 → $39). The diff viewer
renders three clearly-highlighted regions instead of a wall of solid
colour.

To make the baseline portable across operating systems, the suite's
`playwright.config.ts` overrides
`snapshotPathTemplate: "{snapshotDir}/{testFilePath}-snapshots/{arg}{ext}"`
— stripping the default `{-projectName}{-platform}` suffix so a single
checked-in PNG works for every contributor.

The baseline is rendered by
`packages/dashboard/scripts/seed/playwright/make-visual-baseline.mjs`,
which launches `chromium` via `@playwright/test`, sets the same viewport
the spec uses, renders V1_HTML, and screenshots the `#page` locator —
exactly the same code path the spec takes for the actual capture, so V1
and V2 are pixel-comparable. Rerun the script if V1 ever needs to
change. Keep V1_HTML in the script and V2_HTML in the spec in sync —
only the three delta lines should differ.

### Manual harness for a live dashboard (no setup:local)

`packages/e2e/tests/visual-regression.spec.ts` is a separate harness
pointing at the Playwright docs site. Inline comments walk through
`--update-snapshots` to capture a clean baseline, toggling a
page-mutating banner, and re-running to drive the failure path against a
local dashboard.

## Verification

- `pnpm typecheck` — clean (dashboard + reporter).
- `pnpm lint` — clean for changed files (the one remaining oxlint error
  is in `setup-local.mjs`, untouched here).
- `pnpm test` — 290 / 290 passing (196 dashboard + 94 reporter).
- Local seed run: `WRIGHTFUL_FIXTURE_FAILURES=1 npx playwright test
--config scripts/seed/playwright/playwright.config.ts
scripts/seed/playwright/visual-regression.spec.ts` produces three
  attachments named `landing-expected.png`, `landing-actual.png`,
  `landing-diff.png` per attempt — the exact wire shape the reporter
  promotes to `type: "visual"`. Diff PNG visibly highlights the three
  intentional deltas (headline, button, price).
- All seed specs resolve at the new path: `npx playwright test --config
scripts/seed/playwright/playwright.config.ts` (no failure flag) →
  5 passed, 4 skipped, cart/checkout/flaky/visual-regression all picked
  up.

End-to-end verification (manual; user runs `pnpm dev` themselves):

1. With dashboard running locally and `WRIGHTFUL_URL` + `WRIGHTFUL_TOKEN`
   exported, generate a baseline:
   `pnpm test:e2e --update-snapshots tests/visual-regression.spec.ts`.
   Commit the resulting `tests/visual-regression.spec.ts-snapshots/` dir
   so subsequent runs verify against it.
2. Uncomment the `page.evaluate()` block in
   `packages/e2e/tests/visual-regression.spec.ts` and re-run. The test
   fails; the reporter ships three image attachments (one per role).
3. Inspect the tenant DB:
   `SELECT name, type, role, snapshotName, attempt FROM artifacts WHERE testResultId = ?` —
   expect three rows, type `visual`, sharing `snapshotName`.
4. Open the test detail page: rail shows one `Visual diff: <snapshotName>`
   entry. Dialog renders all four tabs. Side-by-side aligns. URL gains
   `?vmode=…` when switching tabs.
5. Backward compat: pin reporter to the currently-published version, rerun
   the same test → falls through to legacy 3-screenshot rendering with no
   ingest validation errors.
6. Hostile-naming smoke: in a passing test do
   `await testInfo.attach('foo-actual.png', { body, contentType: 'image/png' })`
   with no expected/diff sibling — `promoteSnapshotTriples` keeps it as a
   plain screenshot.
