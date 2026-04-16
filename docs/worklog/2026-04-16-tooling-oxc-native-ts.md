# 2026-04-16 — Tooling: oxc (oxlint + oxfmt) + @typescript/native-preview

## What changed

Replaced the zero-tooling setup (only `tsc --noEmit`) with a full code quality stack: oxlint for linting, oxfmt for formatting, tsgolint for type-aware lint rules, `tsgo` for fast type checking, and husky + lint-staged for pre-commit hooks.

## New dependencies (root devDependencies)

| Package                      | Version   | Purpose                                               |
| ---------------------------- | --------- | ----------------------------------------------------- |
| `oxlint`                     | 1.60.0    | Rust-based linter (replaces ESLint)                   |
| `oxlint-tsgolint`            | 0.21.1    | Type-aware linting backend (powered by typescript-go) |
| `oxfmt`                      | 0.45.0    | Rust-based formatter (replaces Prettier)              |
| `@typescript/native-preview` | 7.0.0-dev | Native `tsgo` compiler for fast type checking         |
| `husky`                      | 9.1.7     | Git hooks manager                                     |
| `lint-staged`                | 16.4.0    | Run linters on staged files only                      |

`typescript` remains in per-package devDeps — tsup, vite, drizzle-kit, and wrangler depend on its programmatic API.

## Configuration files added

### `.oxlintrc.json`

- **Plugins:** `typescript`, `import` (+ `react` scoped to dashboard TSX via overrides)
- **Categories:** `correctness` (error), `suspicious` (warn), `perf` (warn)
- **Type-aware rules enabled:** `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-unnecessary-type-assertion`
- **Standard rules:** `no-unused-vars` (error), `no-explicit-any` (warn), `import/no-cycle` (error)
- **Disabled:** `no-await-in-loop` (all instances are intentional retry/chunking loops), `consistent-return` (conflicts with rwsdk middleware pattern)
- **Test overrides:** `no-explicit-any`, `no-unsafe-argument`, `no-unsafe-type-assertion` off in test files
- **Ignore patterns:** `dist`, `coverage`, `.wrangler`, `*.d.ts`, `drizzle`

### `.oxfmtrc.json`

Matches existing code style: double quotes, semicolons, 2-space indent, trailing commas, 80 char print width.

### `.husky/pre-commit`

Runs `lint-staged` on commit. The `lint-staged` config in `package.json`:

- JS/TS files: `oxlint --fix` then `oxfmt --write`
- JSON/MD/YAML/CSS: `oxfmt --write`

Husky auto-installs via the `"prepare": "husky"` script on `pnpm install`.

## Scripts added

**Root `package.json`:**

- `lint` / `lint:fix` — oxlint across monorepo
- `format` / `format:fix` — oxfmt check/write
- `typecheck` — runs `tsgo --noEmit` on cli + dashboard

**Per-package:**

- `packages/cli` — `typecheck` changed from `tsc --noEmit` to `tsgo --noEmit`
- `packages/dashboard` — `typecheck: "tsgo --noEmit"` added (was missing entirely, which was a CI bug)

## Missing tsconfigs added

- `packages/github-action/tsconfig.json` — ES2022, ESNext, bundler resolution, strict
- `packages/e2e/tsconfig.json` — Same, with `noEmit: true`, includes tests + scripts

Both were needed for type-aware linting to resolve types in those packages.

## CI updated

`.github/workflows/ci.yml` `lint-and-typecheck` job now runs:

1. `pnpm lint` (oxlint with type-aware rules)
2. `pnpm format` (oxfmt check)
3. Per-package typecheck with `tsgo`

## Code fixes from linting

| File                                      | Fix                                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/src/lib/parser.ts`                   | Removed unused `PlaywrightSpec`, `PlaywrightTest` imports; added exhaustive `default` case to `mapStatus` switch                                           |
| `cli/src/lib/api-client.ts`               | Replaced `body as unknown as IngestResponse` type assertion with explicit object construction; wrapped `body.error` in `String()` for template expressions |
| `cli/src/__tests__/ci-detect.test.ts`     | Prefixed unused `originalEnv` with `_`                                                                                                                     |
| `dashboard/src/__tests__/schemas.test.ts` | Renamed destructured-but-unused vars (`retryCount` -> `_retryCount`, `tags` -> `_tags`, `annotations` -> `_annotations`)                                   |
| `dashboard/src/client.tsx`                | Added `void` to unhandled `initClient()` promise                                                                                                           |
| `dashboard/src/app/pages/run-detail.tsx`  | Fixed TS2339 — rwsdk types `requestInfo.params` as `DefaultAppContext`; widened to `Record<string, unknown>` to access route param `id`                    |
| `e2e/scripts/run-e2e.js`                  | `void main()` for floating promise; simplified unnecessary template expressions                                                                            |

## Pre-existing bug fixed

CI called `pnpm --filter @greenroom/dashboard typecheck` but that script didn't exist (only `types` and `check`). Dashboard also had a TS2339 error on `params.id`. Both are now fixed — typecheck passes clean.

## Verification

| Check            | Result                                      |
| ---------------- | ------------------------------------------- |
| `pnpm typecheck` | 0 errors (CLI + Dashboard)                  |
| `pnpm lint`      | 0 errors, 0 warnings                        |
| `pnpm format`    | All 72 files formatted                      |
| `pnpm test`      | 88/88 tests pass                            |
| Pre-commit hook  | Tested — oxlint + oxfmt run on staged files |
