import { expect, test } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();

test.describe("Authed navigation", () => {
  test("project page renders the All Runs heading and at least one run row", async ({
    page,
  }) => {
    await page.goto(`/t/${fixture.teamSlug}/p/${fixture.projectSlug}`);
    await expect(
      page.getByRole("heading", { name: /all runs/i }),
    ).toBeVisible();

    // The seeded Playwright dogfood run produced ≥1 row. The empty state copy
    // would only show if seeding silently failed — which is what we want to
    // catch here.
    await expect(page.getByText(/no test runs yet/i)).not.toBeVisible();
    const runLinks = page.locator(
      `a[href*="/t/${fixture.teamSlug}/p/${fixture.projectSlug}/runs/"]`,
    );
    await expect(runLinks.first()).toBeVisible();
  });

  test("clicking a run row navigates to the run-detail page", async ({
    page,
  }) => {
    await page.goto(`/t/${fixture.teamSlug}/p/${fixture.projectSlug}`);
    const firstRunLink = page
      .locator(
        `a[href*="/t/${fixture.teamSlug}/p/${fixture.projectSlug}/runs/"]`,
      )
      .first();
    const href = await firstRunLink.getAttribute("href");
    expect(href).toBeTruthy();

    await firstRunLink.click();
    await expect(page).toHaveURL(new RegExp(`${href}(\\?|$)`));
  });

  test("404 on a project that doesn't exist (no team-existence leak)", async ({
    page,
  }) => {
    const res = await page.goto(`/t/${fixture.teamSlug}/p/does-not-exist`);
    // 404 OR 200 with not-found shell — both are valid. Just confirm we
    // don't accidentally render the project page chrome for a phantom slug.
    expect(res).not.toBeNull();
    await expect(
      page.getByRole("heading", { name: /all runs/i }),
    ).not.toBeVisible();
  });
});
