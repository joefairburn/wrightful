# 2026-04-16 — CLI + GitHub Action: tsup → tsdown (rolldown)

## What changed

Migrated the two `tsup`-built packages (`packages/cli`, `packages/github-action`) over to `tsdown` — the rolldown-team's tsup-compatible DX wrapper, powered by rolldown. Aligns the repo on the rolldown toolchain (dashboard is on stock Vite; Vitest 4 already uses rolldown internally).

## Why

User preference to standardize on rolldown. tsdown was chosen over direct `rolldown` for the DX parity with tsup: near drop-in config, same `dependencies`-are-external default, and config-file ergonomics (`defineConfig`, `clean`, `shims`).

## Dependency changes

| Package                    | Removed       | Added            |
| -------------------------- | ------------- | ---------------- |
| `@wrightful/cli`           | `tsup@^8.5.1` | `tsdown@^0.21.9` |
| `@wrightful/github-action` | `tsup@^8.5.1` | `tsdown@^0.21.9` |

tsdown 0.21.9 pulls `rolldown@1.0.0-rc.16` (coexists with Vitest 4's `rolldown@1.0.0-rc.15` in the lockfile — minor version drift, harmless).

## Config files

### `packages/cli/tsdown.config.ts` (new)

Replaces the deleted `packages/cli/tsup.config.ts`.

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  sourcemap: true,
  clean: true,
  outputOptions: {
    banner: "#!/usr/bin/env node",
    entryFileNames: "[name].js",
  },
});
```

Notes:

- `commander`, `cosmiconfig`, `zod` stay external (tsdown's default for `dependencies`) — matches tsup's previous behavior.
- `entryFileNames: "[name].js"` overrides tsdown's default `.mjs` extension so the CLI's `bin` field (`./dist/index.js`) resolves.
- tsdown auto-detects the shebang banner and grants `chmod +x` on the output file (tsup required manual chmod).

### `packages/github-action/tsdown.config.ts` (new)

Replaces the inline `tsup src/index.ts --format esm --target node20` command in the old `build` script.

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  sourcemap: true,
  clean: true,
  deps: {
    alwaysBundle: [/.*/],
  },
  shims: true,
  outputOptions: {
    entryFileNames: "[name].js",
  },
});
```

Notes:

- **`deps.alwaysBundle: [/.*/]`** — inverts tsdown's default so that `@actions/core` / `@actions/github` (declared in `dependencies` — would otherwise be external) get inlined. The GitHub Actions `node20` runner does not `npm install` on the action, so `dist/index.js` must be self-contained.
- **`shims: true`** — provides `__dirname` / `__filename` polyfills for ESM output, which `@actions/*` often needs.
- Output path preserved at `dist/index.js` to match `action.yml`'s `main:` field (no action.yml change needed).

## Script changes

**`packages/cli/package.json`:**

- `build`: `tsup` → `tsdown`
- `dev`: `tsup --watch` → `tsdown --watch`

**`packages/github-action/package.json`:**

- `build`: `tsup src/index.ts --format esm --target node20` → `tsdown`

## CLAUDE.md

Both `tsup` mentions updated to `tsdown` (package description + build command comment).

## Verification

| Check                                          | Result                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm --filter @wrightful/cli build`           | `dist/index.js` 20.92 KB, gzip 6.59 KB, built in 22ms                                             |
| `pnpm --filter @wrightful/github-action build` | `dist/index.js` 0.24 KB (src is placeholder)                                                      |
| `head -1 packages/cli/dist/index.js`           | `#!/usr/bin/env node`                                                                             |
| `ls -l packages/cli/dist/index.js`             | `-rwxr-xr-x` (execute bit set by tsdown)                                                          |
| `node packages/cli/dist/index.js --help`       | Commander help renders, upload subcommand listed                                                  |
| CLI externals check                            | `import { Command } from "commander"` preserved in bundle — commander/cosmiconfig/zod not inlined |
| `pnpm --filter @wrightful/cli test`            | 83/83 tests pass                                                                                  |
| `pnpm typecheck`                               | 0 errors (CLI + Dashboard)                                                                        |
| `pnpm lint`                                    | 0 errors, 5 pre-existing warnings (unrelated)                                                     |

## Bundle size note

The CLI bundle grew from ~13.5 KB (tsup/esbuild) to ~20.9 KB (tsdown/rolldown) — ~55% larger. Sourcemap and helper output are different between the two bundlers; 20 KB is still well within the "tiny CLI" range so not worth optimizing.

## Follow-ups / watch-outs

- When Phase 4 implements the GitHub Action and imports `@actions/core` / `@actions/github`, re-verify the bundle is self-contained (`grep -c "@actions/core" packages/github-action/dist/index.js` — expect the package name only as string literals, not `import`/`require` calls).
- If we ever add a new runtime dep to the CLI, remember to declare it in `dependencies` (not `devDependencies`) so tsdown keeps it external — otherwise it'll silently get bundled.
- Lockfile now contains two adjacent rolldown RC versions (`rc.15` from Vitest, `rc.16` from tsdown). Not an issue today; worth collapsing at the next routine dep bump.
