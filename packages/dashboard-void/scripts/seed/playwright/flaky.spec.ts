import { test, expect } from "@playwright/test";

// These tests only run when WRIGHTFUL_FIXTURE_FAILURES=1 — they deliberately
// fail / flake to exercise the dashboard's error UI, so they're gated off by
// default (scenarios 1 and 3 stay all-green).

const INCLUDE_FAILURES = process.env.WRIGHTFUL_FIXTURE_FAILURES === "1";

test.describe("Promo codes", () => {
  test.skip(!INCLUDE_FAILURES, "only runs in the failures scenario");

  test("blocks expired promo codes @fails", async ({ page }) => {
    await page.setContent("<div id=root>no expiry check</div>");
    // Deliberate failure — exercises the error UI in the dashboard. The
    // expected stack/message flows through ingest into test_results.
    await expect(page.locator("#root")).toHaveText("expired promo rejected", {
      timeout: 1000,
    });
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring fixtures, even when unused.
  test("validates promo under load @flaky", async ({}, testInfo) => {
    // Fails on first attempt, passes on retry — produces the "flaky" status
    // once Playwright aggregates attempts.
    expect(testInfo.retry).toBeGreaterThan(0);
  });
});
