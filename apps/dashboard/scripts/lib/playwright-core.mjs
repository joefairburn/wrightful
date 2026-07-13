// `playwright-core` is a transitive dep (via @playwright/test) and isn't
// directly resolvable under pnpm — hop through @playwright/test, which is.
// Shared by scripts/sync-trace-vendor.mjs, scripts/vendor-trace-viewer.mjs,
// and src/__tests__/trace-viewer-vendor.test.ts so the resolution dance
// (and its two-step fallback) lives in exactly one place.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import pc from "picocolors";

function toResult(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return { dir: dirname(pkgPath), version: pkg.version };
}

/**
 * Resolve the installed `playwright-core` package, hopping through
 * `@playwright/test` when pnpm's strict node_modules layout hides it as a
 * transitive dependency. Throws (uncaught) if neither resolution path
 * works — the test suite wants that raw throw; the CLI scripts use
 * `resolvePlaywrightCoreOrExit` below for a friendlier print-and-exit.
 *
 * @param {string} requireFrom - passed straight to `createRequire` (a file
 *   URL string or a directory path with a trailing slash) — the location to
 *   resolve `playwright-core` / `@playwright/test` from.
 * @returns {{ dir: string, version: string }}
 */
export function resolvePlaywrightCore(requireFrom) {
  const req = createRequire(requireFrom);
  try {
    return toResult(req.resolve("playwright-core/package.json"));
  } catch {
    // fall through to the @playwright/test hop below
  }
  const testPkg = req.resolve("@playwright/test/package.json");
  const req2 = createRequire(testPkg);
  return toResult(req2.resolve("playwright-core/package.json"));
}

/**
 * `resolvePlaywrightCore`, but on failure prints a `[label]`-prefixed
 * "is it installed?" hint and exits(1) — the shared error-handling style of
 * the two CLI scripts, which used to duplicate this try/catch byte-for-byte.
 *
 * @param {string} importMetaUrl - the calling script's `import.meta.url`.
 * @param {string} label - script name used as the error-message prefix.
 * @returns {{ dir: string, version: string }}
 */
export function resolvePlaywrightCoreOrExit(importMetaUrl, label) {
  try {
    return resolvePlaywrightCore(importMetaUrl);
  } catch {
    console.error(
      pc.red(
        `[${label}] could not resolve \`playwright-core\` (via @playwright/test). Is it installed? Run \`pnpm install\`.`,
      ),
    );
    process.exit(1);
  }
}
