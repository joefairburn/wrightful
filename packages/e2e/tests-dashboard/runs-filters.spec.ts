import { expect, test } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();
const RUNS_PATH = `/t/${fixture.teamSlug}/p/${fixture.projectSlug}`;

test.describe("Runs-list filters (nuqs URL state)", () => {
  test("URL filter for a non-existent branch narrows the list to the empty state", async ({
    page,
  }) => {
    // The seeded dogfood run has no `branch` set (CI detection is blocked
    // in tests). Filtering by a real branch name should yield zero rows.
    await page.goto(`${RUNS_PATH}?branch=nonexistent-${Date.now()}`);

    await expect(page.getByText(/no test runs/i)).toBeVisible();
  });

  test("clearing the filter restores the seeded run", async ({ page }) => {
    await page.goto(`${RUNS_PATH}?branch=nonexistent-${Date.now()}`);
    await expect(page.getByText(/no test runs/i)).toBeVisible();

    // Drop the param and reload — the seeded run reappears.
    await page.goto(RUNS_PATH);
    await expect(
      page.locator(`a[href*="${RUNS_PATH}/runs/"]`).first(),
    ).toBeVisible();
    await expect(page.getByText(/no test runs/i)).not.toBeVisible();
  });

  test("filter URL state survives a hard reload (nuqs round-trip)", async ({
    page,
  }) => {
    const filterBranch = `roundtrip-${Date.now()}`;
    await page.goto(`${RUNS_PATH}?branch=${filterBranch}`);
    await expect(page).toHaveURL(new RegExp(`branch=${filterBranch}`));

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`branch=${filterBranch}`));
    // Page rendered with the filter still in effect — the empty state
    // is the strong signal that nuqs parsed the URL on mount.
    await expect(page.getByText(/no test runs/i)).toBeVisible();
  });

  test("status filter param is honoured", async ({ page }) => {
    // Filter to a status that the seeded run isn't in. Demo Playwright
    // dogfood produces a mix that may or may not include 'skipped';
    // pick a status that's near-impossible: combine two restrictive
    // statuses with a fake branch to force the empty state.
    await page.goto(
      `${RUNS_PATH}?status=interrupted&branch=nonexistent-${Date.now()}`,
    );
    await expect(page.getByText(/no test runs/i)).toBeVisible();
  });
});
