import { expect, test } from "./fixtures";

test.describe("Runs-list filters (nuqs URL state)", () => {
  test("URL filter for a non-existent branch narrows the list to the empty state", async ({
    runsListPage,
  }) => {
    await runsListPage.goto(`branch=nonexistent-${Date.now()}`);
    await expect(runsListPage.emptyState).toBeVisible();
  });

  test("clearing the filter restores the seeded run", async ({
    runsListPage,
  }) => {
    await runsListPage.goto(`branch=nonexistent-${Date.now()}`);
    await expect(runsListPage.emptyState).toBeVisible();

    await runsListPage.goto();
    await expect(runsListPage.runLinks.first()).toBeVisible();
    await expect(runsListPage.emptyState).not.toBeVisible();
  });

  test("filter URL state survives a hard reload (nuqs round-trip)", async ({
    runsListPage,
  }) => {
    const filterBranch = `roundtrip-${Date.now()}`;
    await runsListPage.goto(`branch=${filterBranch}`);
    await expect(runsListPage.page).toHaveURL(
      new RegExp(`branch=${filterBranch}`),
    );

    await runsListPage.page.reload();
    await expect(runsListPage.page).toHaveURL(
      new RegExp(`branch=${filterBranch}`),
    );
    await expect(runsListPage.emptyState).toBeVisible();
  });

  test("status filter param is honoured", async ({ runsListPage }) => {
    await runsListPage.goto(
      `status=interrupted&branch=nonexistent-${Date.now()}`,
    );
    await expect(runsListPage.emptyState).toBeVisible();
  });
});
