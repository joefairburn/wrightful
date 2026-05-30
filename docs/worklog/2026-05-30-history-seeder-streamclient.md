# 2026-05-30 — History seeder drives the reporter's StreamClient (F61)

## What changed

Collapsed the second, untested ingest HTTP client that lived inside
`setup-local.mjs`'s `--history` path into the reporter's existing
`StreamClient`. The synthesized-history seeder now drives the same
open → chunked-append → complete pipeline the reporter uses, behind one tested
interface, instead of hand-rolling a bare `postJson` loop.

Before this change, the `--history` branch (setup-local.mjs:234-273) inlined
its own client: a `headers` object with a hand-retyped
`"X-Wrightful-Version": "3"`, a bare `postJson` that JSON-stringified, set the
Bearer + Content-Type, and threw on `!res.ok` with no retry, no per-attempt
timeout, no `Retry-After` honoring. That was a strictly weaker re-derivation of
`StreamClient.openRun / appendResults / completeRun`, which already encode the
hard-won ingest behaviour (retry on 5xx/429, per-attempt `AbortSignal` timeout,
`Retry-After`, and the aggressive `completeRun` retry that exists precisely
because a dropped complete leaves a run stuck at `status='running'`). A
maintainer touching ingest semantics had two clients to keep honest, only one
tested, and the magic protocol-version string was duplicated.

The benefit here is duplication / single-sourcing and DX correctness, **not** a
production availability fix: this is a local-dev convenience script that targets
miniflare, where the rate limiter fails open (no 429s) — see
`middleware/03.rate-limit.ts`.

## Details

| File                                            | Change                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/reporter/src/index.ts`                | Re-export `{ AuthError, StreamClient }` so the package's public `.` export exposes the ingest client.                                    |
| `packages/reporter/src/client.ts`               | `completeRun` gains an optional `completedAt` (in the options arg); body stays `{ status, durationMs }` when omitted.                    |
| `apps/dashboard/scripts/seed/ingest-runs.mjs`   | New pure-orchestration seam: `chunk`, `ingestRun`, `ingestRuns` over an injected `IngestClient`.                                         |
| `apps/dashboard/scripts/seed/ingest-runs.d.mts` | Hand-written `.d.mts` so the `src/__tests__` test imports the `.mjs` seam with real types (scripts/ is outside the typechecked program). |
| `apps/dashboard/scripts/setup-local.mjs`        | `--history` builds the reporter, then `new StreamClient(...)` + `ingestRuns(...)`; the inline `postJson` loop is gone.                   |

### Why `completeRun` needed `completedAt`

The history seeder backdates runs months into the past — `completePayload`
carries a `completedAt` (unix seconds) that the dashboard persists to
`runs.completedAt` and that the history chart depends on. The dashboard only
honours the override in local dev (`backdatingAllowed()` /
`VITE_IS_DEV_SERVER`). `StreamClient.completeRun(runId, status, durationMs)`
previously dropped it; routing the seeder through the client as-is would have
collapsed every seeded completion to "now". The new optional `completedAt`
preserves the backdating behaviour while leaving the reporter's production body
shape (`{ status, durationMs }`) byte-for-byte unchanged. The dashboard Zod
`CompleteRunPayloadSchema` already accepts an optional `completedAt`, so the
wire contract canary stays green.

### Why build the reporter first

The reporter's package only exports `./dist/index.js`. `setup-local.mjs` is
`.mjs` and now `await import("@wrightful/reporter")`; Node's resolver needs
`dist/index.js` to exist. The script therefore runs
`pnpm --filter @wrightful/reporter build` before the import — the same guard
`upload-fixtures.mjs` already uses before Playwright loads the reporter.
Confirmed the import resolves from the dashboard cwd (where `setup:local`
runs) after a build.

### Behaviour preserved

- Batch size stays 50; results are chunked identically.
- Per-run failures are still isolated (tally-and-continue), and the first 3
  failures are still written to stderr; on any failure the script still
  `process.exit(1)` after killing the spawned dev server.

## Verification

- `pnpm --filter @wrightful/reporter run typecheck` — clean.
- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- New unit tests:
  - `apps/dashboard/src/__tests__/seed-ingest-runs.test.ts` (9 tests) — `chunk`
    edge cases, ordered open → batched append → complete, `completedAt`
    forwarding, default batch size, failure isolation + `onError` reporting.
  - `packages/reporter/src/__tests__/client.test.ts` — 2 added `completeRun`
    cases: body omits `completedAt` by default, and forwards it when supplied.
- `pnpm --filter @wrightful/reporter test` — 178 passed.
- `pnpm --filter @wrightful/dashboard test` — 585 passed.
- `vp fmt --check` + `vp lint` on changed files — formatted, 0 errors (the 6
  lint warnings are pre-existing `no-unsafe-type-assertion` in `client.ts`,
  none introduced here).
- Verified `import { StreamClient } from "@wrightful/reporter"` resolves at
  runtime from the dashboard cwd after `pnpm --filter @wrightful/reporter build`.
