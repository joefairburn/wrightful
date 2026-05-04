import { expect, test } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();

test.describe("Auth", () => {
  test.describe("anonymous", () => {
    // Drop the seeded storageState so these tests run as a logged-out browser.
    test.use({ storageState: { cookies: [], origins: [] } });

    test("redirects an anonymous visitor from / to /login", async ({
      page,
    }) => {
      const response = await page.goto("/");
      // After redirect chain, the final landed page is /login.
      await expect(page).toHaveURL(/\/login(\?|$)/);
      expect(response?.ok()).toBe(true);
    });

    test("redirects an anonymous visitor from a deep team page to /login", async ({
      page,
    }) => {
      await page.goto(`/t/${fixture.teamSlug}/p/${fixture.projectSlug}`);
      await expect(page).toHaveURL(/\/login(\?|$)/);
    });

    test("shows an inline error for invalid sign-in credentials", async ({
      page,
    }) => {
      await page.goto("/login");
      await page.getByLabel(/email/i).fill(fixture.email);
      await page.getByLabel(/password/i).fill("not-the-real-password");
      await page.getByRole("button", { name: /sign in/i }).click();

      await expect(page.getByRole("alert")).toBeVisible();
      // The browser stays on /login.
      await expect(page).toHaveURL(/\/login/);
    });

    test("logs in with valid credentials and lands on the team page", async ({
      page,
    }) => {
      await page.goto("/login");
      await page.getByLabel(/email/i).fill(fixture.email);
      await page.getByLabel(/password/i).fill(fixture.password);
      await page.getByRole("button", { name: /sign in/i }).click();

      // Successful sign-in navigates away from /login. The exact landing
      // page (team picker vs. last-visited project) is implementation
      // detail — assert only on the negative.
      await page.waitForURL((url) => !url.pathname.startsWith("/login"));
      await expect(page).not.toHaveURL(/\/login/);
    });
  });

  test("authed visitor on / is not bounced back to /login", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/login/);
  });
});
