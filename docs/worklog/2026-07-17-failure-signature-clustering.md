# Cross-run failure clustering: persisted signatures, Failures page, new-vs-known badges

## What changed

Failure clustering became a first-class, cross-run feature built on a
**persisted** error fingerprint:

- **Schema.** `testResults.errorSignature` (nullable text) — the normalized
  failure fingerprint, computed at ingest, plus a partial index
  `testResults_project_signature_createdAt_idx (projectId, errorSignature,
createdAt) WHERE errorSignature IS NOT NULL`. Migration
  `20260717220925_chubby_blockbuster.sql`.
- **Ingest.** `buildResultInsertStatements` stamps each final result with
  `failureSignature(status, errorMessage, errorStack)` (new in
  `src/lib/error-signature.ts`); the queued prefill writes `null`; the
  `/results` upsert refreshes it from `excluded`. The fingerprint rule is the
  MCP dossier's old `errorHead` rule verbatim: only `flaky`/`failed`/`timedout`
  finals, message first, stack fallback when the message is blank.
- **Failures page.** New `pages/…/failures.{tsx,server.ts}` + a "Failures"
  sidebar entry: per-signature clusters over a 7/14/30d window (occurrences,
  affected tests, first/last seen, newest example row link, "New" pill),
  KPI strip (distinct patterns / new this window / total occurrences).
  Loaders live in `src/lib/analytics/failures.ts` — query-builder reads (not
  raw SQL) so Drizzle's decoders handle the int8/bigint coercion.
- **Run page.** Failure rows in the Tests tab carry a "New" badge when their
  signature's first CI appearance is this run. `loadNewFailureFlags`
  (`src/lib/failure-novelty.ts`) is a UI-only enrichment applied by the
  dashboard `GET …/results` route next to `attachHasTrace` — it does NOT enter
  the shared `loadRunResultsPage` projection, so the public v1 / export / MCP
  contracts are unchanged. Live-broadcast rows carry no flag until the next
  paginated read (same contract as `hasTrace`).
- **MCP consolidation.** `diagnose.ts` (diagnose_flaky_tests /
  get_test_history) now reads the persisted column instead of fetching
  2 KB `errorHead`s and normalizing at read time — the dashboard and the MCP
  tools can no longer disagree about a row's grouping key. `FAILURE_STATUSES`
  moved to `src/lib/error-signature.ts` (ingest can't import from `mcp/`).

## Why

The per-run signature grouping added with the MCP tools (#57) answered "what
is failing in this run" but not the triage question a reporting dashboard
exists for: "is this failure new, or the same thing that's been failing all
week?" Computing signatures on read can't answer it — classifying a run's
failures against all history would normalize the whole retained failure
partition per page load. Persisting at ingest makes both surfaces one indexed
query. Pre-launch, so the column + backfill-free migration is cheap now and
would be an operation later.

## Decisions worth remembering

- **First-seen is project-wide, CI-only, retention-bounded.** Synthetic
  (monitor) traffic is excluded from clustering and novelty, matching every
  analytics surface. A signature quiet longer than run retention resurfaces
  as "new" — intended semantics (a regression after months is news).
- **The stored value freezes the normalizer.** Changing
  `normalizeErrorSignature`'s masking rules now requires a backfill over
  retained `testResults` rows, or old and new rows group apart. Pre-first-
  deploy that's a `void db reset`/reseed; post-launch it's a real migration —
  budget for it before touching the regexes.
- **Novelty definition:** a signature is known iff any CI occurrence has
  `createdAt < run.createdAt`. Two overlapping runs racing the same brand-new
  failure can both badge "New" — accepted as the honest reading.

## Verification

- `vp test run` unit lanes: `error-signature.workers.test.ts` (new
  `failureSignature` cases), `analytics-kpi-summaries.test.ts` (new
  `summarizeFailureKpis` cases).
- New `pg-integration/failure-clustering.test.ts`: window aggregate (incl.
  int8-as-number pinning + synthetic exclusion + branch filter), first-seen,
  examples, and new-vs-known flags against real Postgres semantics;
  `pg-integration/mcp-diagnose.test.ts` reseeded through `failureSignature`
  and still green against the column-reading diagnose.
- Full `pnpm --filter @wrightful/dashboard test` + `pnpm check`.
- Dashboard e2e preflight now covers `/failures` SSR.
