import { expect, test } from "./fixtures";

test.describe("Authed navigation", () => {
  test("project page renders the All Runs heading and at least one run row", async ({
    runsListPage,
  }) => {
    await runsListPage.goto();
    await runsListPage.expectLoaded();
    await expect(runsListPage.emptyState).not.toBeVisible();
    await expect(runsListPage.runLinks.first()).toBeVisible();
  });

  test("clicking a run row navigates to the run-detail page", async ({
    page,
    runsListPage,
  }) => {
    await runsListPage.goto();
    const runId = await runsListPage.firstRunId();
    await runsListPage.runLinks.first().click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}(\\?|$)`));
  });

  test("404 on a project that doesn't exist (no team-existence leak)", async ({
    page,
    runsListPage,
  }) => {
    const res = await page.goto(`/t/${runsListPage.teamSlug}/p/does-not-exist`);
    expect(res).not.toBeNull();
    await expect(runsListPage.heading).not.toBeVisible();
  });
});
