import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Playwright config for the dashboard UI e2e suite.
 *
 * Distinct from `playwright.config.ts` (the dogfood suite that targets
 * playwright.dev to generate streamable test data). This one drives the
 * Wrightful dashboard itself in a real browser.
 *
 * The dashboard is booted by `tests-dashboard/global-setup.ts` (which calls
 * the shared `bootDashboard` helper from `src/dashboard-fixture.ts`).
 * `storageState.json` is populated there too so every spec starts authed.
 *
 * Run locally:    pnpm --filter @wrightful/e2e test:dashboard
 * Headed/debug:   pnpm --filter @wrightful/e2e test:dashboard --headed
 */
// `line` reporter when running under CI or a CLI agent (Claude Code etc.) —
// the default reporter floods stdout with thousands of lines and chews
// through context budgets. Local interactive runs still get `list`.
const isMinimalReporter = process.env.CI || process.env.CLAUDE;

// Dogfood: stream this suite's results into a Wrightful dashboard, same as the
// demo suite (playwright.config.ts). The reporter no-ops gracefully when
// WRIGHTFUL_URL / WRIGHTFUL_TOKEN aren't set (see reporter onBegin), so local
// runs and the env-less CI leg stay quiet; set both to stream.
const dashboardReporter: [string, Record<string, unknown>?] = ["@wrightful/reporter"];

export default defineConfig({
  testDir: "./tests-dashboard",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // File-level parallelism only (`fullyParallel: false`). Specs are
  // parallel-safe at the file boundary because resources are timestamped
  // (api-key labels, signup emails, runIds, filter queries) and project
  // DOs serialize their own writes. logout.spec mints its own session row
  // so signing out doesn't invalidate the shared `storageState.json`
  // session that every other worker holds.
  // One shared dev server (single miniflare + vite + Better Auth on a local
  // D1) backs the whole suite. Under parallel load it gets slow enough that the
  // client-side auth calls and live-update propagation blow their timeouts and
  // flip pass↔fail. Run serially locally so each test hits a responsive server.
  // CI ran 3 workers for throughput, but on a resource-starved runner that
  // tipped the shared server over a cliff — one run came in at 1 failed / 3
  // flaky, the next (same commit) at 18 failed, all pure websocket/navigation/
  // getAttribute timeouts. Dropping to 2 workers gives the server ~33% more
  // headroom and keeps retries:2 to absorb residual flake; the timeout bumps
  // below let a merely-slow (not dead) server still pass.
  workers: process.env.CI ? 2 : 1,
  reporter: isMinimalReporter
    ? [["line"], ["html", { open: "never" }], dashboardReporter]
    : [["list"], dashboardReporter],
  globalSetup: resolve(__dirname, "tests-dashboard/global-setup.ts"),
  globalTeardown: resolve(__dirname, "tests-dashboard/global-teardown.ts"),
  expect: {
    // Sub-pixel rendering noise + tiny font hinting drift between local
    // and CI runners means a strict pixel-perfect diff is too brittle.
    // 1% tolerance catches genuine layout regressions (bar shifts, text
    // wraps, missing element) without flaking on cosmetic noise.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  use: {
    baseURL: "http://localhost:5189",
    storageState: "./tests-dashboard/.auth/storageState.json",
    trace: process.env.CI ? "retain-on-failure" : "on-first-retry",
    screenshot: "only-on-failure",
    // Generous under CI's shared-server load (see the workers note above); the
    // ceilings only bite when the server has genuinely stalled, not merely
    // slowed. Kept tighter locally where each test hits a responsive server.
    actionTimeout: process.env.CI ? 15_000 : 10_000,
    navigationTimeout: process.env.CI ? 25_000 : 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
