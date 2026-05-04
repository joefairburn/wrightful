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
export default defineConfig({
  testDir: "./tests-dashboard",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
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
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
