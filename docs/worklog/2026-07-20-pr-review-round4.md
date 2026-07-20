# 2026-07-20 — PR #58 fourth review round

Follow-ups for the fourth round of review threads on PR #58.

## What changed

- **Artifact download CORS for the separate trace-viewer origin
  (`routes/api/artifacts/[id]/download.ts`)** — with
  `VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN` configured, `bridge.html` on the
  cookieless host fetches the signed trace URL cross-origin, but
  `resolveAllowedOrigin` only echoed the dashboard origin and the hard-coded
  `https://trace.playwright.dev`, so the browser blocked every separate-origin
  replay before the trace could parse. The allow-list now also echoes the
  configured viewer origin (`traceViewerOrigin()`, `""` when unset — never
  matches a real `Origin` header). SELF-HOSTING.md's direct-R2 bucket-CORS
  guidance and the origin-isolation steps now say to add the viewer origin to
  the R2 `AllowedOrigins` (the worker route's allowance is automatic; the
  presigned-GET hop is bucket-side).
- **Open-time enforcement of the per-run row cap (`src/lib/ingest.ts`,
  `routes/api/runs/index.ts`)** — the payload schema's `MAX_PLANNED_TESTS`
  (100k) can exceed a lower operator-configured
  `WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN`, and every prefilled planned test
  persists a `testResults` row, so a fresh open could bypass the stated
  per-run maximum before any append was checked. `openRun` now throws
  `RunRowCapExceededError` (fresh path only — the duplicate path prefills
  nothing and its appends are already capped) before any write, and the
  `/api/runs` route maps it to the same 413 contract as `/results`'
  `rowCapExceeded`.
- **Docs** — the round-3 worklog's verification section now names the Vite+
  commands behind the pnpm scripts (`vp test run` ×2 lanes, `vp check`) and
  records that the pre-commit hook ran.

## Verification

- `ingest-row-cap.test.ts` — 7 passed, incl. two new openRun cases: an
  over-cap fresh open is refused with nothing persisted; an oversized
  duplicate open stays exempt (that path prefills nothing). The pglite
  harness now also creates `runShards` (the duplicate path's stale-shard
  cleanup references it).
- `download-route.workers.test.ts` — 7 passed, incl. two new CORS cases:
  the configured viewer origin is echoed; any other cross-origin caller
  falls back to the dashboard origin.
- Full `pnpm --filter @wrightful/dashboard test` (= `vp test run && vp test
run -c vitest.workers.config.ts`) and `pnpm check` (= `vp check`) pass;
  the Vite+ pre-commit hook ran on the commit (no `--no-verify`).

No schema or migration changes.
