# 2026-05-30 — Shared synthetic-data primitives: one `sha40` for both seeders (F62)

## What changed

Both fixture generators needed a deterministic 40-char hex commit SHA and each
rolled its own `sha40` with a different algorithm:

- `apps/dashboard/scripts/seed/generator.mjs` — `sha40(rand)` drew 20 bytes from
  the shared xorshift32 PRNG (used per-run for `commitSha`).
- `apps/dashboard/scripts/upload-fixtures.mjs` — `sha40(n)` was a self-seeded LCG
  keyed by an integer index, no PRNG dep (used for `--volume` scenario SHAs).

Neither was shared, so the "fake but stable commit SHA" concept lived in two
places with two divergent distributions. This consolidates it onto one
implementation and one contract.

- `seed/catalog.mjs` (already the home for the other PRNG-consuming
  synthetic-data primitives — `buildTestCatalog(rand)`, `branchesForLifecycle`)
  now also owns the two PRNG primitives: `makePrng(seedString)` and
  `sha40(rand)`. Both moved here verbatim from `generator.mjs` (the
  byte-drawing `sha40`, which is the cleaner of the two).
- `generator.mjs` imports `makePrng` + `sha40` from `catalog.mjs` and re-exports
  `makePrng` to preserve its prior public surface. Its per-run `commitSha`
  behaviour is byte-for-byte unchanged.
- `upload-fixtures.mjs` deletes its LCG `sha40` and derives a per-index PRNG via
  `sha40(makePrng(String(n)))`, so its `--volume` SHAs stay deterministic per
  index across runs. The pre-existing volume SHAs change value (the LCG output
  differs from the byte-draw output), but they were always synthetic dev-only
  fixture data with no stable contract.

## Scope note (honesty)

This is a **minor duplication cleanup on shallow leaf utilities, not a
depth/leverage win** — flagged as such by the finding's verifier. `sha40` is a
~10-line pure function; consolidating it across exactly two call sites improves
locality marginally and centralizes no behaviour, invariant, or error mode. It
earns its keep mainly because the two copies had drifted into different
algorithms and the shared helper is now the single place that concept lives.

## Details

| File                                              | Change                                                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/scripts/seed/catalog.mjs`         | Added `makePrng` + `sha40` (the synthetic-data PRNG primitives).                                                                                                                                               |
| `apps/dashboard/scripts/seed/catalog.d.mts`       | New hand-written declaration (the `scripts/` tree is `.mjs` glue outside the `src` program) so the `src/__tests__` test imports `makePrng`/`sha40` with real types; declares the module's full public surface. |
| `apps/dashboard/scripts/seed/generator.mjs`       | Import `makePrng`/`sha40` from `catalog.mjs`; delete the local copies; re-export `makePrng`.                                                                                                                   |
| `apps/dashboard/scripts/upload-fixtures.mjs`      | Delete the LCG `sha40`; import the shared pair and derive per-index SHAs via `sha40(makePrng(String(n)))`.                                                                                                     |
| `apps/dashboard/src/__tests__/seed-sha40.test.ts` | New unit tests for `makePrng` + `sha40` (these primitives were previously untested).                                                                                                                           |

## Verification

- `pnpm --filter @wrightful/dashboard run typecheck` — clean (0 errors).
- `seed-sha40.test.ts` — 7 passed (determinism, [0,1) range, 40-hex format,
  per-index stability across 27 volume indices, and exact 20-draw PRNG advance
  so `sha40` composes with the other generators on a shared stream).
- Full dashboard suite (`vp test run`) — 53 files / 596 tests passed.

Deletion test (DRY, not depth): deleting upload-fixtures' inline `sha40` does
not remove the need for a deterministic SHA — it reappears in `generator.mjs`.
The need now lives in exactly one place (`catalog.mjs`), consumed by both real
callers.
