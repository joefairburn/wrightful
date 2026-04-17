import { test, expect } from "@playwright/test";

// These tests only run when WRIGHTFUL_FIXTURE_CHAOS=1. The `@chaos` tag lets
// the fixture generator filter them in/out per scenario via --grep.

const CHAOS = process.env.WRIGHTFUL_FIXTURE_CHAOS === "1";

test.describe("Promo codes (chaos)", () => {
  test.skip(!CHAOS, "chaos scenarios only");

  test("blocks expired promo codes @chaos @fails", async ({ page }) => {
    await page.setContent("<div id=root>no expiry check</div>");
    // Deliberate failure — exercises the error UI in the dashboard. The
    // expected stack/message flows through ingest into test_results.
    await expect(page.locator("#root")).toHaveText("expired promo rejected", {
      timeout: 1000,
    });
  });

  test("validates promo under load @chaos @flaky", async (_, testInfo) => {
    // Fails on first attempt, passes on retry — produces the "flaky" status
    // once Playwright aggregates attempts.
    expect(testInfo.retry).toBeGreaterThan(0);
  });
});
