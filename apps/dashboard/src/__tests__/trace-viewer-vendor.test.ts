import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VENDORED_PLAYWRIGHT_VERSION } from "@/trace-viewer/vendor/version";

// Resolve playwright-core the same way scripts/vendor-trace-viewer.mjs does:
// it's a transitive dep (via @playwright/test), not directly resolvable under
// pnpm from this package.
function installedPlaywrightCoreVersion(): string {
  const req = createRequire(import.meta.url);
  let pkgPath: string;
  try {
    pkgPath = req.resolve("playwright-core/package.json");
  } catch {
    const testPkg = req.resolve("@playwright/test/package.json");
    pkgPath = createRequire(testPkg).resolve("playwright-core/package.json");
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

describe("trace-viewer vendored source", () => {
  it("matches the installed playwright-core version", () => {
    const installed = installedPlaywrightCoreVersion();
    expect(
      installed,
      `playwright-core was bumped to ${installed} but src/trace-viewer/vendor/ ` +
        `is synced from v${VENDORED_PLAYWRIGHT_VERSION}. Re-sync each vendor/ file ` +
        `from its VENDOR-PROVENANCE path at tag v${installed} (diff against ` +
        `upstream), verify the replay e2e still passes, then update ` +
        `VENDORED_PLAYWRIGHT_VERSION.`,
    ).toBe(VENDORED_PLAYWRIGHT_VERSION);
  });
});
