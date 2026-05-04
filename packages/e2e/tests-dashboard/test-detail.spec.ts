import { expect, test } from "./fixtures";

test.describe("Test detail page", () => {
  test("clicking a test row from run-detail navigates to test-detail", async ({
    page,
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto();
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);
    await runDetailPage.clickFirstTest();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}/tests/`));
  });

  test("test-detail renders the Attempts & errors heading", async ({
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto();
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);
    await runDetailPage.clickFirstTest();
    await expect(runDetailPage.attemptsHeading).toBeVisible({
      timeout: 10_000,
    });
  });

  test("test-detail URL renders the back-link to the parent run", async ({
    page,
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto();
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);
    await runDetailPage.clickFirstTest();

    const runBackLink = page.locator(`a[href$="/runs/${runId}"]`);
    await expect(runBackLink.first()).toBeVisible();
  });
});
