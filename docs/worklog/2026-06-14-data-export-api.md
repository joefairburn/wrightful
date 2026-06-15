# 2026-06-14 — Data export + public query API (roadmap 2.5)

## What changed

Added a **public, Bearer-authed, project-scoped read API** (`/api/v1/*`) for
pulling runs and test results out of Wrightful — for CLIs, scripts, and ad-hoc
CSV exports — plus an in-dashboard **Export CSV** button on the runs list. Both
surfaces share one query + CSV-serialization code path; they differ only in how
the tenant scope is resolved (Bearer key vs session cookie).

This is a **read-path + auth-routing feature only — NO schema changes, NO
migrations.** Everything reads existing `runs` / `testResults` columns. Two new
env keys + one new Cloudflare rate-limiter binding were added.

The auth surface is security-sensitive (it touches the Bearer middleware), so
the query API is wired as a **separate, distinct branch** from reporter ingest —
see below.

## Auth routing: query API ≠ ingest

The reporter ingest API and the new query API are both Bearer-authed, but they
are deliberately **separate route classes with separate middleware branches**:

|                                                 | Ingest (`/api/runs/*`, `/api/artifacts/{register,:id/upload}`) | Query (`/api/v1/*`)                                |
| ----------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Predicate                                       | `isIngestRoute`                                                | `isQueryApiRoute` (new)                            |
| Bearer key lookup + `getApiKey` stash           | ✅                                                             | ✅                                                 |
| `negotiateVersionOrResponse` (version 409 path) | ✅                                                             | ❌ — **no version handshake**                      |
| Missing/invalid key                             | 401                                                            | **401 (never 409)**                                |
| Pre-auth IP backstop (`INGEST_IP_RATE_LIMITER`) | ✅                                                             | ✅ (shared — bounds failed-auth abuse identically) |
| Post-auth throttle                              | `API_RATE_LIMITER` (120/min)                                   | `QUERY_RATE_LIMITER` (600/min — **looser**)        |

Both predicates live in `src/lib/ingest-routes.ts` as the single source of truth,
imported by **both** `02.api-auth.ts` and `03.rate-limit.ts` so the gates can't
drift (same rationale as the existing `isIngestRoute`). The two predicates are
**disjoint** over every `/api/*` path (asserted in `ingest-routes.test.ts`): no
path is ever classified as both, so a query route can never accidentally inherit
the ingest version gate.

**Why no version negotiation on query:** the query API is a stable read contract
for external consumers that send no `X-Wrightful-Version` header. A missing key
401s before any version check would run; there is simply no 409 code path on
this surface — which is what proves the branch is genuinely separate from ingest.

## Tenant isolation

Every query is scoped to the authenticated principal's project. The Bearer
routes resolve `tenantScopeForApiKey(getApiKey(c))` (the key binds the caller to
exactly one project); the in-dashboard route resolves
`resolveProjectApiScope(c)` (session → membership join). Both produce a branded
`TenantScope`, and every read goes through `runScopeWhere` / `scopedRunsWhere` /
`runByIdWhere` / `loadRunResultsPage` — so a project-A principal can never read
project-B rows. A run id that doesn't belong to the scope's project simply
doesn't match the `(projectId, runId)` predicate → 404 (never leaks existence).
`export-where.test.ts` pins that the runs-list WHERE always ANDs both
`teamId` and `projectId`, and that a different scope binds a different id.

## Endpoints

| Route                                             | Auth    | Purpose                                                                                            |
| ------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/v1/runs`                                | Bearer  | List runs (status/branch/env/actor/date/search/origin filters, cursor-paged). `?format=csv` → CSV. |
| `GET /api/v1/runs/:runId`                         | Bearer  | Single run summary.                                                                                |
| `GET /api/v1/runs/:runId/tests`                   | Bearer  | A run's test results (cursor-paged, optional `?status=`). `?format=csv` → CSV.                     |
| `GET /api/t/:teamSlug/p/:projectSlug/export/runs` | Session | In-dashboard runs CSV (filters honored); same serializer as `/api/v1`.                             |

Filtering reuses the dashboard's own `parseRunsFilters` + `scopedRunsWhere`.
Pagination reuses the existing opaque cursor codec (`encodeCursor`/`decodeCursor`
over `(createdAt, id)`), shared with `loadRunResultsPage`. A new
`buildRunsPageWhere` / `loadRunsListPage` (`src/lib/export.ts`) provides the
cursor-paged runs query the offset-based dashboard list page didn't expose.

`GET /api/v1/runs/:runId` is filed as `routes/api/v1/runs/[runId]/index.ts`
(not `[runId].ts`) so the dynamic param can coexist with the `[runId]/tests.ts`
child — matching the repo's `index.ts`-for-collection-root convention and
avoiding a file-vs-directory routing ambiguity.

## CSV format

`src/lib/csv.ts` is a tiny, pure, **RFC-4180-compliant** serializer (no `void/*`
imports). Choices, documented in the module:

- **Row terminator: CRLF (`\r\n`)** — RFC 4180 §2.1; Excel-on-Windows expects
  it, every other consumer accepts it. The strictly-safer "open in a spreadsheet"
  default.
- **Minimal quoting** — a field is quoted only when it contains `"`, `,`, CR, or
  LF; embedded quotes are doubled (`""`).
- **`null`/`undefined` → empty field** (not the word "null").
- **No numeric coercion** — already-typed values are stringified verbatim, so a
  string like `"007"` / a SHA prefix round-trips as text.
- No UTF-8 BOM (bytes are UTF-8; add at the response boundary if ever needed).

`csv.test.ts` covers all of the above exhaustively (commas, quotes, newlines,
CRLF, leading-zero/number-ish strings, empty/null, generator bodies).

### Export streaming + cap

Exports page through the **whole filtered set** server-side via the same cursor
walk as the JSON API (`EXPORT_PAGE_SIZE = 500` per round trip), capped at
`WRIGHTFUL_EXPORT_MAX_ROWS` (default 50,000). Truncation is **not silent**: when
the cap is hit the response carries `X-Wrightful-Export-Truncated: true` and the
handler `logger.warn`s it. Responses set `Content-Disposition: attachment` with
a slug-derived, header-injection-safe filename and `Cache-Control: private,
no-store`.

CSV columns:

- **Runs:** `id, status, branch, environment, commit_sha, commit_message,
pr_number, actor, repo, origin, total_tests, passed, failed, flaky, skipped,
duration_ms, created_at, completed_at`
- **Tests:** `id, test_id, title, file, project_name, status, duration_ms,
retry_count`

## Files

### New

| File                                                     | Purpose                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/csv.ts`                                         | Pure RFC-4180 CSV serializer.                                                                                                            |
| `src/lib/export.ts`                                      | Shared query (`loadRunsListPage` + cursor `buildRunsPageWhere`) + CSV builders + response-header helpers, reused by all export surfaces. |
| `routes/api/v1/runs/index.ts`                            | Bearer runs list + CSV.                                                                                                                  |
| `routes/api/v1/runs/[runId]/index.ts`                    | Bearer single-run summary.                                                                                                               |
| `routes/api/v1/runs/[runId]/tests.ts`                    | Bearer run test results + CSV.                                                                                                           |
| `routes/api/t/[teamSlug]/p/[projectSlug]/export/runs.ts` | Session in-dashboard runs CSV.                                                                                                           |
| `docs/api/query-export.md`                               | API reference (auth, endpoints, cursor pagination, CSV columns).                                                                         |
| `src/__tests__/csv.test.ts`                              | CSV escaping unit tests.                                                                                                                 |
| `src/__tests__/export-where.test.ts`                     | Runs-list WHERE is always projectId/teamId-scoped + cursor bound-params.                                                                 |

### Modified

| File                                      | Change                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/lib/ingest-routes.ts`                | Added `isQueryApiRoute(path)` (`/api/v1/*`).                                                      |
| `middleware/02.api-auth.ts`               | Added the query branch: Bearer lookup WITHOUT version negotiation; version gate kept ingest-only. |
| `middleware/03.rate-limit.ts`             | Added the query branch under `QUERY_RATE_LIMITER` (looser), per-key + IP fallback.                |
| `src/lib/rate-limit.ts`                   | `QUERY_RATE_LIMITER` added to `RATE_LIMITER_BINDING_NAMES`.                                       |
| `wrangler.jsonc`                          | `QUERY_RATE_LIMITER` ratelimit binding (600/min, namespace 1005).                                 |
| `src/lib/tenant-api-scope.ts`             | Added `resolveProjectApiScope(c)` — member-level, no-runId session scope for the export route.    |
| `env.ts`                                  | Added `WRIGHTFUL_EXPORT_MAX_ROWS` (default 50,000).                                               |
| `pages/t/.../index.tsx`                   | Added an **Export CSV** `<a download>` (carries current filters) in the runs page header.         |
| `pages/settings/.../keys.tsx`             | Added a concise "Query & export API" card linking the docs.                                       |
| `src/__tests__/ingest-routes.test.ts`     | Extended with `isQueryApiRoute` match set + ingest/query disjointness.                            |
| `src/__tests__/rate-limit-config.test.ts` | Extended the budget-ordering assertion: QUERY > API (looser than ingest), QUERY < INGEST_IP.      |

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — **clean** (`void prepare`
  regenerated `.void/routes.d.ts` with all four new routes; tsgo no errors).
- `pnpm --filter @wrightful/dashboard test` — **991 passed** (92 files), up from
  967 (new: csv 14, export-where 6, ingest-routes +3, rate-limit-config ordering).
- `pnpm --filter @wrightful/dashboard run check` — **0 errors**, 73 warnings (all
  pre-existing in unrelated files; none reference any new/changed file here).

## Notes / open items

- The plan's optional follow-up (`apiKeys.scopes` to split read-only vs ingest
  keys) was **not** done — it requires a schema change, which 2.5 explicitly
  excludes. Today any valid project key can both ingest and query. Worth doing
  before GA so a "read-only export" key can be handed out without ingest rights.
- The CSV body is assembled in memory (not a true streamed `ReadableStream`). The
  `WRIGHTFUL_EXPORT_MAX_ROWS` cap is what keeps that bounded (~50k short rows is a
  few MB, comfortably within a Worker response). If exports grow, switch
  `buildRunsCsv` to a streaming response — the cursor walk already supports it.
- The docs link in `keys.tsx` now points at the canonical
  `github.com/joefairburn/wrightful` repo (matching `packages/reporter/package.json`),
  fixed in the review pass below.

## Adversarial review + fixes

Reviewed across five dimensions (auth boundary, tenant isolation, CSV, query
correctness, UI/docs). The two highest-risk dimensions came back clean: the
**auth boundary** is sound (a no/invalid key on `/api/v1/*` → 401 with no version
path; the ingest branch still runs `negotiateVersionOrResponse`; `isQueryApiRoute`
is anchored and disjoint from ingest; the IP backstop holds), and **tenant
isolation** is intact (every v1/export query is `projectId`-scoped, the `[runId]`
routes 404 a foreign run via the ownership probe, the cursor isn't a cross-tenant
lever). Six findings were confirmed; all fixed:

- **(high→ the one real security gap) CSV formula injection.** `escapeCsvField`
  framed fields per RFC-4180 but did NOT neutralize a cell beginning with `= + - @`
  (or a leading TAB/CR) — a spreadsheet evaluates those as live formulas
  (`=HYPERLINK`/`WEBSERVICE`/DDE) on import, and the columns include
  attacker-controlled free text (branch, commit message, actor, repo, test title,
  file). The serializer now prefixes a single quote to such fields so they import
  as literal text. The guard is **string-only**, so typed numbers/booleans (e.g. a
  negative `durationMs`) are untouched. Fixed in the single shared serializer, so
  all three export surfaces are covered. Regression tests added.
- **(low) unbounded export cap.** `WRIGHTFUL_EXPORT_MAX_ROWS` had a safe default
  but no ceiling, and the CSV is assembled in memory — a misconfigured huge value
  could OOM the isolate. `resolveExportCap` now clamps the cap to
  `[1, EXPORT_HARD_MAX_ROWS=200k]` at the consumption site (keeping the
  codebase's bare-`number().default()` env convention).
- **(low) inverted date range.** `?from=…&to=…` with `from > to` ANDed two
  mutually-exclusive bounds into a silent always-empty 200. `parseRunsFilters`
  now swaps an inverted range to the intended window (ISO dates compare
  lexically); applies uniformly to JSON, CSV, and the in-dashboard list.
- **(low) placeholder docs URL.** The "API reference" link pointed at a
  non-existent `github.com/wrightful/wrightful` repo (404); corrected to the
  canonical `joefairburn/wrightful`.

Re-verified: typecheck clean, **995 tests pass** (92 files, +4), `vp check` 0 errors.
