# 2026-06-24 — Fix: duplicate `@codemirror/state` broke the CodeMirror editor

## Symptom

Loading a monitor page (the create/edit form or the detail page's read-only
"Test definition") threw at runtime in the browser:

```
Uncaught Error: Unrecognized extension value in extension set ([object Object]).
This sometimes happens because multiple instances of @codemirror/state are
loaded, breaking instanceof checks.
```

The `CodeEditor` island (`src/components/ui/code-editor.tsx`, `@uiw/react-codemirror`
+ `@codemirror/lang-javascript`) renders on those pages, so the editor was dead.

## Root cause

Two copies of `@codemirror/state` were resolved into the dashboard's client
graph — **6.6.0 and 6.7.0**. CodeMirror requires `@codemirror/state` (and
`@codemirror/view`) to be **singletons**: extensions are tagged by the
`@codemirror/state` instance that created them and checked with `instanceof`, so
a second copy makes every extension "unrecognized."

`@uiw/react-codemirror@4.25.10` (a dependency bump already present in the
in-progress, uncommitted lockfile) resolved its CodeMirror peer dependencies
inconsistently: most of its sub-packages (`autocomplete`, `commands@6.10.3`,
`language`, `lint`, `lang-javascript`, `view`) saw `@codemirror/state@6.6.0`,
while `commands@6.10.4` and `search@6.7.0` saw `@codemirror/state@6.7.0`. Both
copies ended up in the same bundle. (`@codemirror/view` stayed a clean singleton
at `6.43.0` — only `state` was split.)

## Fix

Pin `@codemirror/state` to a single version via a pnpm override in the root
`package.json`:

```jsonc
"pnpm": {
  "overrides": {
    "@codemirror/state": "6.7.0"
  },
  ...
}
```

`6.7.0` is the highest version already in the tree and satisfies every
`@codemirror/*` package's `^6` peer range. An **exact** pin (not `^6.7.0`) is
deliberate: it's a singleton, so we want to force one copy rather than risk a
future minor reintroducing the split. **Do not remove this override** without
confirming `pnpm --filter @wrightful/dashboard why @codemirror/state` still
reports a single version.

## Verification

- `pnpm install` re-resolved cleanly.
- `pnpm --filter @wrightful/dashboard why @codemirror/state` → **1 version (6.7.0)**.
- `pnpm why @codemirror/state -r` → **0** references to `6.6.0` monorepo-wide; the lockfile now carries only `@codemirror/state@6.7.0`. (A `6.6.0` orphan dir lingers in the pnpm store, unreferenced — cleaned on the next prune.)
- `tsgo --noEmit` (dashboard) → exit 0.
- Not reproduced in a running browser (the user runs the dev server). The browser error is a direct consequence of the duplicate resolution, which is now eliminated. **After pulling this, restart the dev server** so Vite re-optimizes deps (clear `node_modules/.vite` if it persists).
