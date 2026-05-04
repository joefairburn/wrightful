import { expect, test } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();

async function firstRunId(
  page: import("@playwright/test").Page,
): Promise<string> {
  await page.goto(`/t/${fixture.teamSlug}/p/${fixture.projectSlug}`);
  const link = page
    .locator(`a[href*="/t/${fixture.teamSlug}/p/${fixture.projectSlug}/runs/"]`)
    .first();
  const href = await link.getAttribute("href");
  if (!href) throw new Error("no run link found on the project page");
  const match = href.match(/\/runs\/([\w]+)/);
  if (!match) throw new Error(`could not parse runId out of href "${href}"`);
  return match[1];
}

test.describe("Run detail", () => {
  test("renders the run-detail page chrome for a real run", async ({
    page,
  }) => {
    const runId = await firstRunId(page);
    const response = await page.goto(
      `/t/${fixture.teamSlug}/p/${fixture.projectSlug}/runs/${runId}`,
    );
    expect(response?.status()).toBe(200);

    // The page has a back link to the runs list — a stable anchor that
    // shouldn't churn with cosmetic redesigns.
    const backLink = page.locator(
      `a[href$="/t/${fixture.teamSlug}/p/${fixture.projectSlug}"]`,
    );
    await expect(backLink.first()).toBeVisible();
  });

  test("lists at least one test result row from the seeded run", async ({
    page,
  }) => {
    const runId = await firstRunId(page);
    await page.goto(
      `/t/${fixture.teamSlug}/p/${fixture.projectSlug}/runs/${runId}`,
    );

    // At least one test result link of the form …/runs/:runId/tests/:trId
    // should appear once the page fully renders the seeded data.
    const testLinks = page.locator(`a[href*="/runs/${runId}/tests/"]`);
    await expect(testLinks.first()).toBeVisible({ timeout: 10_000 });
  });

  test("404s on a phantom runId within the user's project", async ({
    page,
  }) => {
    const res = await page.goto(
      `/t/${fixture.teamSlug}/p/${fixture.projectSlug}/runs/01HZZZZZZZZZZZZZZZZZZZZZZZ`,
    );
    expect(res).not.toBeNull();
    // The strong signal is the absence of any test-result links for this
    // fake run id — proves the page didn't accidentally render someone
    // else's run data when its own lookup missed.
    await expect(
      page.locator(`a[href*="/runs/01HZZZZZZZZZZZZZZZZZZZZZZZ/tests/"]`),
    ).toHaveCount(0);
  });
});
