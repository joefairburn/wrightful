/**
 * Visual regression baseline for the run-detail page.
 *
 * Disabled by default — Playwright snapshots are platform-specific
 * (font hinting + OS-level rendering differs between macOS and the
 * Linux CI runner), so a baseline committed from one platform will
 * always diff against the other. Two ways to enable:
 *
 *   1. Local-only iteration: set `WRIGHTFUL_VISUAL_BASELINE_OK=1` and
 *      run `pnpm --filter @wrightful/e2e test:dashboard visual.spec.ts
 *      --update-snapshots`. Use the generated PNG to triage what's
 *      changed; do NOT commit the macOS PNG.
 *
 *   2. Ratchet on CI: enable the env var in `.github/workflows/ci.yml`
 *      for the test-e2e-ui job, run once with --update-snapshots from
 *      a one-shot workflow to generate Linux PNGs, commit those, then
 *      re-enable in the regular CI job. From that point onwards the
 *      job catches layout regressions on every PR.
 *
 * Masks: timestamps, durations, commit SHAs, and run IDs change on
 * every run — masked so they don't trigger spurious diffs.
 */
import { expect, test, type Page } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();
const VISUAL_ENABLED = process.env.WRIGHTFUL_VISUAL_BASELINE_OK === "1";

async function firstRunHref(page: Page): Promise<string> {
  await page.goto(`/t/${fixture.teamSlug}/p/${fixture.projectSlug}`);
  const link = page
    .locator(`a[href*="/t/${fixture.teamSlug}/p/${fixture.projectSlug}/runs/"]`)
    .first();
  const href = await link.getAttribute("href");
  if (!href) throw new Error("no seeded run on the project page");
  return href;
}

test.describe("Visual regression", () => {
  test.skip(!VISUAL_ENABLED, "Set WRIGHTFUL_VISUAL_BASELINE_OK=1 to enable");

  test("run-detail page matches the committed baseline", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const href = await firstRunHref(page);
    await page.goto(href);

    // Let the synced-state subscription settle (status pill animation
    // can leave a subtle pulse mid-frame otherwise).
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveScreenshot("run-detail.png", {
      fullPage: true,
      // Mask everything that varies run-to-run.
      mask: [
        page.locator("[data-testid='timestamp']"),
        page.locator(".tabular-nums"), // counters, durations
        page.locator("[class*='font-mono'][class*='text-muted-foreground']"),
      ],
      animations: "disabled",
    });
  });
});
