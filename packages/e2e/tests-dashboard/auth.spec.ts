import { expect, test } from "./fixtures";

test.describe("Auth", () => {
  test.describe("anonymous", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("redirects an anonymous visitor from / to /login", async ({
      page,
    }) => {
      const response = await page.goto("/");
      await expect(page).toHaveURL(/\/login(\?|$)/);
      expect(response?.ok()).toBe(true);
    });

    test("redirects an anonymous visitor from a deep team page to /login", async ({
      page,
      ctx,
    }) => {
      await page.goto(`/t/${ctx.teamSlug}/p/${ctx.projectSlug}`);
      await expect(page).toHaveURL(/\/login(\?|$)/);
    });

    test("shows an inline error for invalid sign-in credentials", async ({
      loginPage,
      ctx,
    }) => {
      await loginPage.gotoSignIn();
      await loginPage.signIn(ctx.email, "not-the-real-password");
      await expect(loginPage.errorAlert).toBeVisible();
      await expect(loginPage.page).toHaveURL(/\/login/);
    });

    test("logs in with valid credentials and lands on the team page", async ({
      loginPage,
      ctx,
    }) => {
      await loginPage.gotoSignIn();
      await loginPage.signIn(ctx.email, ctx.password);
      await loginPage.waitForLandedOff("/login");
      await expect(loginPage.page).not.toHaveURL(/\/login/);
    });
  });

  test("authed visitor on / is not bounced back to /login", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/login/);
  });
});
