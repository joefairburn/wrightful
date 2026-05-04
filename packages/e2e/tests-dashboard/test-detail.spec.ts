import { expect, test, type Page } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();
const RUNS_PATH = `/t/${fixture.teamSlug}/p/${fixture.projectSlug}`;

async function firstRunId(page: Page): Promise<string> {
  await page.goto(RUNS_PATH);
  const link = page.locator(`a[href*="${RUNS_PATH}/runs/"]`).first();
  const href = await link.getAttribute("href");
  if (!href) throw new Error("no run link found");
  const match = href.match(/\/runs\/([\w]+)/);
  if (!match) throw new Error(`could not parse runId from "${href}"`);
  return match[1];
}

test.describe("Test detail page", () => {
  test("clicking a test row from run-detail navigates to test-detail", async ({
    page,
  }) => {
    const runId = await firstRunId(page);
    await page.goto(`${RUNS_PATH}/runs/${runId}`);

    const testLink = page.locator(`a[href*="/runs/${runId}/tests/"]`).first();
    await expect(testLink).toBeVisible({ timeout: 10_000 });
    const testHref = await testLink.getAttribute("href");
    expect(testHref).toBeTruthy();
    expect(testHref).toMatch(new RegExp(`/runs/${runId}/tests/[\\w]+`));

    await testLink.click();
    await page.waitForURL(new RegExp(`/runs/${runId}/tests/`), {
      timeout: 10_000,
    });
  });

  test("test-detail renders the Attempts & errors heading", async ({
    page,
  }) => {
    const runId = await firstRunId(page);
    await page.goto(`${RUNS_PATH}/runs/${runId}`);
    const testLink = page.locator(`a[href*="/runs/${runId}/tests/"]`).first();
    await testLink.click();

    await expect(
      page.getByRole("heading", { name: /attempts & errors/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("test-detail URL renders the back-link to the parent run", async ({
    page,
  }) => {
    // Stable smoke check: every test-detail page links back to its
    // parent run. If this breaks, the breadcrumb / back-nav has
    // regressed. Lighter than asserting on attempt-panel content
    // (which depends on the seeded test's status).
    const runId = await firstRunId(page);
    await page.goto(`${RUNS_PATH}/runs/${runId}`);
    const testLink = page.locator(`a[href*="/runs/${runId}/tests/"]`).first();
    await testLink.click();
    await page.waitForURL(/\/tests\//, { timeout: 10_000 });

    const backLink = page.locator(`a[href$="/runs/${runId}"]`);
    await expect(backLink.first()).toBeVisible();
  });
});
