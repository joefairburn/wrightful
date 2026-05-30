# 2026-05-30 — Shared v3 payload builder for the history seeder (F63)

## What changed

The local history seeder (`apps/dashboard/scripts/seed/generator.mjs`) used to
hand-assemble the v3 wire payloads — `openPayload` (run meta + planned tests),
the per-test result objects, and `completePayload` — as object literals. That
made it a **third, untested copy** of the streaming-ingest contract alongside
the reporter's TypeScript interfaces (`packages/reporter/src/types.ts`) and the
dashboard's Zod schemas (`apps/dashboard/src/lib/schemas.ts`). CLAUDE.md calls
that contract "shared… kept in sync via a canary contract test", but the
seeder's copy was outside the canary and had **already drifted**: its
`plannedTests` omitted `projectName`, and its result objects omitted both
`projectName` and `workerIndex`. It only validated because the Zod schemas mark
those fields `.optional()`. A maintainer adding a required wire field would
update `types.ts` + `schemas.ts` + `contract.test.ts` and silently leave the
seeder producing invalid payloads that only fail against a live server.

Extracted a small **plain-data payload builder** into the reporter package and
routed the seeder through it. The reporter derives payloads from live
Playwright objects (`buildPayload` / `buildTestDescriptor`); the seeder has only
synthetic plain data, so the new builder takes the few fields it owns and
returns the same wire shape — concentrating the contract behind one interface.

The seeder keeps all its genuinely-unique logic (PRNG, incident windows, PR
lifecycles, attempt synthesis, and the dev-only `createdAt`/`completedAt`
backdating that rides the `BackdateSeconds` escape hatch). It now just _feeds_
the builder instead of re-deriving the shape.

## Details

| File                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/reporter/src/payload.ts`          | **New.** `buildOpenRunPayload(meta, planned)`, `buildResult(fields, attempts)`, `buildAttempt(input)`, `buildCompleteRunPayload(status, durationMs)`. Returns objects typed against `types.ts`; fills nullable error fields with `null`, defaults `workerIndex` to 0, defaults `clientKey` to `testId`, derives `expectedTotalTests` from `planned.length`. Validates required structural fields at runtime (non-empty `testId`/`title`/`file`/`idempotencyKey`, `projectName` present even if `null`, ≥1 attempt) so the untyped `.mjs` seeder fails loudly rather than at the live server. |
| `packages/reporter/src/index.ts`            | Re-export the builders + their input types (`RunMeta`, `ResultFields`, `AttemptInput`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/dashboard/scripts/seed/generator.mjs` | `buildTestResult` and `buildRun` now feed the builders. Drift fixed: `projectName: null` (synthetic runs use the default unnamed project) and `workerIndex: 0` are now emitted; attempt error fields are normalised.                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/dashboard/scripts/setup-local.mjs`    | Build the reporter **before** importing `generator.mjs` — the generator now statically imports `@wrightful/reporter`, so the dist must exist first.                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Why this path (and not the finder's first option)

The finding's path (a) — reuse the reporter's `buildPayload`/`buildTestDescriptor`
— is not viable: those consume Playwright `TestCase`/`PendingTest` objects
(`test.parent.project()`, `test.titlePath()`, `test.location`) that the seeder
does not have. Only a shared **plain-data** builder applies. Because the seeder
is untyped `.mjs`, the builder validates required fields at runtime; that is
what actually closes the "silently invalid until runtime" failure mode.

## Verification

- `packages/reporter/src/__tests__/payload.test.ts` — **new**, 12 unit tests for
  the builders (defaults, `projectName`/`workerIndex` emission, runtime
  validation of the drift fields, empty-attempts rejection).
- `packages/reporter/src/__tests__/contract.test.ts` — **extended**: builder
  output is now parsed through the dashboard's real Zod schemas (the existing
  cross-package canary) and checked for exact key-set equivalence, making the
  seeder's producer a first-class member of the contract.
- Runtime smoke test: `generateHistory({ months: 1 })` → all 350 runs' open /
  results / complete payloads parse through `OpenRunPayloadSchema` /
  `AppendResultsPayloadSchema` / `CompleteRunPayloadSchema`; `projectName`,
  `workerIndex`, `clientKey`, and the backdating fields are all present.
- `pnpm --filter @wrightful/reporter run typecheck` — clean.
- `pnpm --filter @wrightful/dashboard run typecheck` — clean.
- Reporter tests: 194 passed (14 files). Dashboard tests: 585 passed (51 files).

## Integration gap

The dashboard vitest aliases `void/db` to a stub, so the live-server ingest of
seeded payloads isn't unit-covered. The contract canary + the runtime smoke
test together prove the produced shapes parse through the dashboard's schemas,
which is the boundary the drift bug lived at.
