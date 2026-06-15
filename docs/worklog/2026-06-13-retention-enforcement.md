# 2026-06-13 — Two-axis data-retention enforcement (roadmap 1.2)

## What changed

The dashboard now **enforces** the two-axis retention model that was previously only a documented intention. A new `sweep-retention` cron deletes data past its team's retention windows on two independent axes:

- **Artifact bytes** (`retentionArtifactDays`, default 30) — R2 storage cost. Expired artifacts have their R2 objects **and** rows deleted.
- **testResults rows** (`retentionTestResultsDays`, default 90) — D1 size cost. Expired testResults are deleted; the FK cascade removes their attempts/tags/annotations/artifact rows. `runs` summary rows are kept (the aggregate counters live there), so run history outlives its detail.

The two windows are separate because the cost/value profiles differ: bytes (traces/videos) dominate storage spend and expire faster; run history is cheap and valuable longer. Both are per-team configurable (nullable columns → env default) and editable by owners on the team General settings page.

## Details

| Area   | Change                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema | `teams.retentionArtifactDays` + `teams.retentionTestResultsDays` (nullable int, null → env default); new index `artifacts(projectId, createdAt)` for the age scan. Migration `20260613162606_bored_edwin_jarvis.sql`. |
| Env    | `WRIGHTFUL_RETENTION_ARTIFACT_DAYS` (30), `WRIGHTFUL_RETENTION_TEST_RESULTS_DAYS` (90), `WRIGHTFUL_RETENTION_SWEEP_BATCH_SIZE` (200).                                                                                 |
| Lib    | New `src/lib/retention.ts`: `resolveRetentionWindows` (pure) + `sweepRetention` (bounded per-project sweep). New `deleteArtifactObjectsByKeys` in `src/lib/artifacts.ts` (R2 bulk delete by key, paged at 1000).      |
| Cron   | New `crons/sweep-retention.ts` (`0 */6 * * *` — distinct from the five-minute reaper family and the daily usage rollup).                                                                                              |
| UI     | "Data retention" card on `pages/settings/teams/[teamSlug]/general.{server.ts,tsx}` with an owner-only `updateRetention` action.                                                                                       |

## Design notes

- **Per-project sweep, not global.** A global `WHERE createdAt < cutoff` can't use the `(projectId, createdAt)` index (projectId is the leading column), so the sweep iterates projects and seeks each project's oldest rows in createdAt order. It also lets each project pick up its team's window. Bounded by `limit` rows per axis per project per pass (modeled on `sweepStaleRuns`), so a backlog drains across successive passes.
- **Orphan-free by construction.** The artifact-age pass deletes R2 objects before rows. The testResults pass _also_ deletes the R2 objects of the artifacts it's about to cascade-delete — so an expiring testResult never strands live R2 bytes, even if the windows are misconfigured or the artifact sweep is backlogged.
- **Window invariant.** The settings editor validates artifact window ≤ testResults window (using the effective value, override-or-default), reinforcing the orphan-free property at the source.

## Verification

- `vp exec tsgo --noEmit` — clean.
- `vp test run` — **882 passed (83 files)**. New `src/__tests__/retention.test.ts` covers `resolveRetentionWindows` (override/default precedence).
- `vp check --fix` — 0 errors (70 pre-existing reporter warnings, unrelated).
- `void db generate` — migration generated and inspected (two nullable columns + the new index).
- Not yet exercised: the DB/R2-touching `sweepRetention` against live D1/R2 (covered by the e2e dogfood suite per the standing real-D1-harness gap).
