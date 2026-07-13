import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { resolvePlaywrightCore } from "../../scripts/lib/playwright-core.mjs";
import { VENDORED_PLAYWRIGHT_VERSION } from "@/trace-viewer/vendor/version";

// Resolve playwright-core the same way scripts/vendor-trace-viewer.mjs and
// scripts/sync-trace-vendor.mjs do — it's a transitive dep (via
// @playwright/test), not directly resolvable under pnpm from this package.
function installedPlaywrightCoreVersion(): string {
  return resolvePlaywrightCore(import.meta.url).version;
}

// Dashboard package root (this file lives at src/__tests__/). Under vitest's
// module runner `import.meta.url` is a plain filesystem path, not a `file:`
// URL — handle both forms.
const testFilePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : import.meta.url;
const packageRoot = join(testFilePath, "..", "..", "..");

describe("trace-viewer vendored source", () => {
  it("matches the installed playwright-core version", () => {
    const installed = installedPlaywrightCoreVersion();
    expect(
      installed,
      `playwright-core was bumped to ${installed} but src/trace-viewer/vendor/ ` +
        `is synced from v${VENDORED_PLAYWRIGHT_VERSION}. Run ` +
        `\`pnpm --filter @wrightful/dashboard sync:trace-vendor\` to re-pull ` +
        `the machine-managed vendor files from tag v${installed}, then ` +
        `manually re-verify the hand-extracted files (protocol-types.ts, ` +
        `language.ts) against that tag, then update ` +
        `VENDORED_PLAYWRIGHT_VERSION in vendor/version.ts (the sync script ` +
        `bumps it for you on a normal run).`,
    ).toBe(VENDORED_PLAYWRIGHT_VERSION);
  });

  // Offline drift canary: the machine-managed vendor files must stay
  // byte-identical to what scripts/sync-trace-vendor.mjs last wrote
  // (recorded as sha256 hashes in vendor/vendor-manifest.json).
  it("matches the vendor-manifest.json content hashes (no hand edits)", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(packageRoot, "src/trace-viewer/vendor/vendor-manifest.json"),
        "utf8",
      ),
    ) as { files: Record<string, string> };

    const entries = Object.entries(manifest.files);
    expect(entries.length).toBeGreaterThan(0);

    for (const [relPath, expected] of entries) {
      const actual = createHash("sha256")
        .update(readFileSync(join(packageRoot, relPath)))
        .digest("hex");
      expect(
        actual,
        `${relPath} does not match its hash in vendor-manifest.json. ` +
          `Vendor files are machine-managed — don't hand-edit them. If the ` +
          `file needs a fix, register it as a bodyPatches entry in ` +
          `scripts/sync-trace-vendor.mjs and re-run ` +
          `\`pnpm --filter @wrightful/dashboard sync:trace-vendor\` (which ` +
          `rewrites the file AND refreshes the manifest).`,
      ).toBe(expected);
    }
  });
});
