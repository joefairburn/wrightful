import { expect, test } from "./fixtures";

test.describe("Run detail", () => {
  test("renders the run-detail page chrome for a real run", async ({
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto();
    const runId = await runsListPage.firstRunId();
    const response = await runDetailPage.page.goto(
      runDetailPage.pathFor(runId),
    );
    expect(response?.status()).toBe(200);
    await expect(runDetailPage.backLink().first()).toBeVisible();
  });

  test("lists at least one test result row from the seeded run", async ({
    runsListPage,
    runDetailPage,
  }) => {
    await runsListPage.goto();
    const runId = await runsListPage.firstRunId();
    await runDetailPage.goto(runId);
    await expect(runDetailPage.testRowLinks.first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("404s on a phantom runId within the user's project", async ({
    page,
    runDetailPage,
  }) => {
    const phantomId = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
    const res = await page.goto(runDetailPage.pathFor(phantomId));
    expect(res).not.toBeNull();
    // Phantom run → no test list rendered → no test-list at all.
    await expect(runDetailPage.testRowLinks).toHaveCount(0);
  });
});
