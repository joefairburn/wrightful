# 2026-04-24 — Flaky Tests page: review fixes

Follow-up to `2026-04-23-flaky-tests-page.md`, addressing issues raised in code
review.

## What changed

1. **Header count reflects the true total.** The `{n} Flaky Tests` header now
   uses the un-sliced aggregate count (`rankedAll.length`) instead of
   `ranked.length`. When the page caps at `TOP_N`, the subtitle appends
   `— showing top 50` so the rendered list and the reported total can't
   silently diverge.
2. **Branch filter UI.** Dropped the "UI TBD" note from the original worklog:
   the `RunHistoryBranchFilter` (already used on run-detail) now renders under
   the page heading. The `?branch=` query param it writes was already honored
   by every query on this page.
3. **Sparkline + recent-failures queries consolidated.** The previous
   `loadSparklines` / `loadRecentFailures` helpers fanned out `TOP_N` parallel
   queries apiece. Because all work inside a single `TenantDO` serializes on
   the DO's event loop, `Promise.all` didn't actually parallelize — it just
   issued 100 sequential round-trips per render. Replaced with two single-pass
   queries using `row_number() OVER (PARTITION BY testId ORDER BY createdAt
DESC)` subqueries filtered to `rn ≤ SPARKLINE_SIZE` / `rn ≤ RECENT_FAILURES`.
4. **Authoritative title/file.** Removed `max(testResults.title)` /
   `max(testResults.file)` from the aggregate — these picked the
   lexicographically-largest value, not the latest. Title and file now come
   from the `rn = 1` row in the sparkline query, which is the most recent
   execution.

## Files

- **Modified** `packages/dashboard/src/app/pages/flaky-tests.tsx`

No schema changes. SQLite window functions (3.25+) are supported in the DO
SQLite build.

## Verification

- `pnpm format:fix` — clean.
- `pnpm lint` — 0 errors; 26 preexisting warnings, unchanged.
- `pnpm typecheck` — clean.
- `pnpm test` — dashboard 151/151 pass; reporter suite flaked once on the
  pre-existing unreachable-dashboard test, passed on rerun; unrelated to this
  change.
- `pnpm test:e2e` — pre-existing failure on R2 key pattern unrelated to this
  change (reproduces on `main`).
