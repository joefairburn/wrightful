# 2026-05-30 — wire-contract source: guard the response half + the version literal

## What changed

The reporter↔dashboard v3 wire contract had a single-source canary on the
**request** side — `packages/reporter/src/__tests__/contract.test.ts` builds the
reporter's outbound payloads and parses them through the dashboard's Zod request
schemas (`apps/dashboard/src/lib/schemas.ts`), so a field rename on either side
fails the build. Two halves of the same contract were still unguarded:

1. **The response side (server → reporter) was unchecked.** The reporter read
   `runId`/`runUrl`, the `clientKey → testResultId` mapping, and the artifact
   `uploads` off each JSON body in `client.ts` via inline `as` casts with no
   schema behind them. A field rename on the dashboard handlers (e.g.
   `testResultId` → `testResultIdentifier`) would have silently broken the
   artifact-registration step that hangs off that mapping, with nothing red. (F06)

2. **The protocol-version literal was a third hand-maintained copy.** The
   reporter stamped a module-private `const PROTOCOL_VERSION = 3` onto the
   `X-Wrightful-Version` header (`client.ts`); the dashboard independently kept a
   module-private `SUPPORTED_VERSIONS = new Set(["3"])` accept-set it 409s against
   (`api-auth.ts`). Two literals + two header-name string literals, in two
   packages, kept in step by discipline alone. (F33, F76)

Both gaps are now closed at the **existing** cross-package canary — no new
runtime package, and the reporter is **not** coupled to dashboard Zod at runtime
(honoring the verifier's narrowing on F06/F33: the dashboard-only ingest security
validation stays in the dashboard; the test is the only place the two packages'
literals meet).

### Response contract (F06)

- Added `OpenRunResponseSchema` / `AppendResultsResponseSchema` (with
  `ResultMappingSchema`) / `RegisterArtifactsResponseSchema` (with
  `ArtifactUploadSchema`) to `schemas.ts`. They describe **exactly the fields the
  reporter reads** and are `.passthrough()` so handler extras the reporter
  ignores (`duplicate`, `maxBytes`, `unknownTestResultIds`) are tolerated, not
  flagged as drift.
- Added mirror interfaces `OpenRunResponse` / `ResultMapping` /
  `AppendResultsResponse` / `RegisterArtifactsResponse` to the reporter's
  `types.ts`. `client.ts` now types its response casts as `Partial<*Response>`
  and `appendResults` returns `ResultMapping[]`, so a reporter-side rename is a
  compile error.
- The contract test parses values typed as the reporter interfaces through the
  dashboard `*ResponseSchema`s — closing the loop in both directions.

### Version literal (F33 / F76)

- `PROTOCOL_VERSION` and `WRIGHTFUL_VERSION_HEADER` are now **exported** from the
  reporter's `types.ts` (formerly a private const in `client.ts` + a repeated
  `"X-Wrightful-Version"` string literal). `client.ts` imports both and uses the
  header constant as a computed key in `this.headers` and the artifact-PUT
  headers.
- The dashboard's `SUPPORTED_VERSIONS` + `WRIGHTFUL_VERSION_HEADER` moved into
  `schemas.ts` (next to the wire-shape contract, the one module the canary already
  imports); `api-auth.ts` imports both instead of defining the set inline and
  hardcoding the header name.
- The contract test asserts `SUPPORTED_VERSIONS.has(String(PROTOCOL_VERSION))`
  and that the two header-name constants are identical — bump the reporter's
  version (or rename the header) on one side without the other and the build goes
  red.

### Structural-equivalence guard (deepening the request canary)

The request-side parse tests prove the reporter's payloads are _accepted_, but
acceptance is one-directional — a never-emitted optional schema field or a
silently-stripped reporter field would both parse clean. Added three key-set
equality tests (TestResult, TestAttempt, planned-test descriptor) comparing the
Zod schema's declared keys against the keys the reporter actually emits, so a
one-sided field shows up as an exact-equality failure.

## Details

| Module                                             | Change                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/lib/schemas.ts`                | + `WRIGHTFUL_VERSION_HEADER`, `SUPPORTED_VERSIONS`, four `*ResponseSchema`s + inferred types |
| `apps/dashboard/src/lib/api-auth.ts`               | import header + accept-set from `schemas.ts`; drop the inline `const SUPPORTED_VERSIONS`     |
| `packages/reporter/src/types.ts`                   | + exported `PROTOCOL_VERSION`, `WRIGHTFUL_VERSION_HEADER`, four `*Response` interfaces       |
| `packages/reporter/src/client.ts`                  | import version constants + response types; type response casts as `Partial<*Response>`       |
| `packages/reporter/src/__tests__/contract.test.ts` | + response-contract, protocol-version, and structural-equivalence describe blocks            |

The handler response shapes were verified against the new schemas:
`POST /api/runs` → `{ runId, runUrl, duplicate? }` (routes/api/runs/index.ts),
`POST /api/runs/:id/results` → `{ results: mapping }` (routes/api/runs/[id]/results.ts),
`POST /api/artifacts/register` → `{ uploads }` (routes/api/artifacts/register.ts).

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — 0 errors.
- `pnpm --filter @wrightful/dashboard test` — 135/135.
- `pnpm --filter @wrightful/reporter test` — 150/150 (was 136; +14 from the new
  response/version/structural describe blocks).
- `pnpm check` — 0 errors, 83 warnings (matches baseline; the response-cast
  `no-unsafe-type-assertion` warnings are pre-existing in kind — the casts already
  existed, only their target type changed).
- Integration gap (no real-D1 harness): the contract test is the enforcement
  point but does not exercise the live handlers — it parses representative
  response values, not real D1/R2 round-trips. The full request→response cycle is
  covered only by the live e2e dogfood suite.
