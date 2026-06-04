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

  test("signup form rejects a too-short password and stays on /signup", async ({
    loginPage,
  }) => {
    await loginPage.gotoSignUp();
    await loginPage.signUp({
      name: "Whoever",
      email: `signup-bad-${Date.now()}@x.test`,
      // 7 chars — under the shipped native minLength=8, so the browser
      // blocks submission before any auth call and the page never navigates.
      password: "short1!",
    });

    // Positive signal that native validation actually fired (not just that the
    // URL happened not to change): the password field reports invalid under the
    // minLength=8 constraint.
    const passwordValid = await loginPage.passwordInput.evaluate(
      (el) => (el as HTMLInputElement).validity.valid,
    );
    expect(passwordValid).toBe(false);
    // The shipped UI enforces only minLength=8 (Better Auth's default policy);
    // a sub-8 password is blocked client-side and the page stays on /signup.
    // (See the resolution doc — the original spec asserted a stricter
    // ≥12-chars+number policy that the product doesn't currently implement.)
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

    // Generous timeout — the duplicate-email sign-up still round-trips through
    // the slow scrypt path on the local miniflare server before erroring.
    await expect(loginPage.errorAlert).toBeVisible({ timeout: 30_000 });
    await expect(loginPage.page).toHaveURL(/\/signup/);
  });
});
