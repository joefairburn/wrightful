// Type surface for the JSDoc-typed `playwright-core.mjs` seam. The `scripts/`
// tree is `.mjs` glue (outside the typechecked `src` program), so this
// hand-written declaration lets `src/__tests__/trace-viewer-vendor.test.ts`
// import the shared resolver with real types instead of an implicit `any`.

/**
 * Resolve the installed `playwright-core` package (hopping through
 * `@playwright/test` when pnpm's strict layout hides it as a transitive
 * dependency). `requireFrom` is passed straight to `createRequire`.
 */
export function resolvePlaywrightCore(requireFrom: string): {
  dir: string;
  version: string;
};

/**
 * `resolvePlaywrightCore`, but on failure prints a `[label]`-prefixed hint
 * and exits(1) — the CLI scripts' shared error-handling style.
 */
export function resolvePlaywrightCoreOrExit(
  importMetaUrl: string,
  label: string,
): {
  dir: string;
  version: string;
};
