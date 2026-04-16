# 2026-04-16 — Playwright Version Compatibility Strategy

## What changed

Added a forward-compatibility testing strategy to ensure the CLI parser doesn't break when Playwright updates its JSON report format. Also added Renovate config so Playwright updates are automatically surfaced via PRs, and documented the versioning contract in the codebase.

## Context

The CLI parses Playwright JSON report files using hand-written TypeScript interfaces (`packages/cli/src/types.ts`). These types intentionally cover only the ~15 fields Greenroom needs out of the 50+ in Playwright's `JSONReport` interfaces. The parser was already resilient to additive changes (optional chaining, defaults), but there was no test proving this, no automation for detecting Playwright updates, and no documentation of why the types are hand-written.

Key design decision: **do not import types from `@playwright/test`**. The CLI has zero Playwright dependency and must stay that way — `@playwright/test` pulls browser binaries as transitive deps, and users may run any Playwright version.

## Files added

| File                                                   | Purpose                                                                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test-fixtures/sample-report-future.json` | Fixture with extra fields from Playwright 1.59.1+ (`parallelIndex`, `shardIndex`, `stdout`, `stderr`, `steps`, result-level `annotations`, `errorLocation`, extra config fields like `globalTimeout`, `fullyParallel`) |
| `packages/cli/src/__tests__/playwright-compat.test.ts` | 4 forward-compatibility tests proving the parser handles newer Playwright formats                                                                                                                                      |
| `renovate.json`                                        | Auto-PRs for Playwright updates, grouped and labeled `playwright-update`, weekly schedule                                                                                                                              |

## Files modified

| File                        | Change                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/types.ts` | Added header comment documenting the versioning contract: why types are hand-written, what subset they represent, last verified Playwright version |
| `.github/workflows/ci.yml`  | Added comment explaining the e2e job serves as a Playwright format canary                                                                          |

## Compatibility test details

The `playwright-compat.test.ts` suite validates:

1. **Future fixture parsing** — Report with extra fields from Playwright 1.59.1+ parses correctly
2. **Output equivalence** — Parser produces identical test IDs, statuses, durations, errors, tags, and annotations regardless of extra fields in the input
3. **Unknown top-level keys** — Completely unknown keys (e.g. `metadata`, `projectSetups`, `customReporterData`) don't cause errors
4. **Extra suite/spec fields** — Unknown fields at any nesting level (`location`, `retries`, `entries`, `repeatEachIndex`, `titlePath`) are silently ignored

## What we chose NOT to do

- **Zod validation of Playwright input** — Would reject reports with new unknown fields (strict parsing). The current lenient approach is correct for an input format we don't control.
- **Version-specific parser adapters** — Over-engineering. Playwright's JSON format has been structurally stable (additive-only changes) across all 1.x releases. If a breaking change ever happens, a single `if` branch is the right fix.
- **Importing `@playwright/test` types** — Would bloat CLI install with browser binaries. The hand-written subset approach is intentional.
- **Multi-version CI matrix** — Unnecessary. The forward-compat test + Renovate-triggered e2e canary provides the same coverage.

## How the canary works

The e2e CI job already generates a real Playwright JSON report and feeds it through the CLI parser → dashboard ingest pipeline. When Renovate bumps `@playwright/test` and opens a PR, this entire flow runs automatically. If Playwright changes the JSON report format in a breaking way, the e2e job fails — serving as the early warning system.

## Verification

- `pnpm --filter @greenroom/cli test` — 66 tests pass (including 4 new compat tests)
- `pnpm lint` — 0 warnings, 0 errors
- `pnpm format` — all files formatted correctly
- `pnpm --filter @greenroom/cli typecheck` — clean
