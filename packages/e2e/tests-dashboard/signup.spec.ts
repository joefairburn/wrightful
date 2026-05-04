import { expect, test } from "./fixtures";

test.describe("Sign-up flow (anonymous)", () => {
  // No storageState — a fresh, logged-out browser. The fixture's primary
  // user is irrelevant here; we sign up a new identity.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("creates a new account via /signup and lands authed", async ({
    page,
    loginPage,
  }) => {
    // Unique email per run so re-running without a fresh DO wipe doesn't
    // 409 on a duplicate account.
    const email = `signup-${Date.now()}@wrightful.test`;
    await loginPage.gotoSignUp();
    await loginPage.signUp({
      name: "Signup Spec",
      email,
      password: "signup-spec-pw-12345",
    });

    await loginPage.waitForLandedOff("/signup");
    await expect(page).not.toHaveURL(/\/signup/);

    // Authed: navigating to / should not bounce to /login.
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("signup form validates password policy client-side (no auth call)", async ({
    loginPage,
  }) => {
    await loginPage.gotoSignUp();
    await loginPage.signUp({
      name: "Whoever",
      email: `signup-bad-${Date.now()}@x.test`,
      password: "short1",
    });

    await expect(loginPage.errorAlert).toContainText(
      /at least 12 characters and include a number/i,
    );
    await expect(loginPage.page).toHaveURL(/\/signup/);
  });

  test("signing up with the suite's primary user's email surfaces a server error", async ({
    loginPage,
    ctx,
  }) => {
    await loginPage.gotoSignUp();
    await loginPage.signUp({
      name: "Duplicate",
      email: ctx.email,
      password: "never-going-to-work-1",
    });

    await expect(loginPage.errorAlert).toBeVisible();
    await expect(loginPage.page).toHaveURL(/\/signup/);
  });
});
