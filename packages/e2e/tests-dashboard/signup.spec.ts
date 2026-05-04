import { expect, test } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();

test.describe("Sign-up flow (anonymous)", () => {
  // No storageState — a fresh, logged-out browser. The fixture's primary
  // user is irrelevant here; we sign up a new identity.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("creates a new account via /signup and lands authed", async ({
    page,
  }) => {
    // Unique email per run so re-running the suite without wiping DOs
    // (e.g. dev iteration) doesn't 409 on an existing account.
    const email = `signup-${Date.now()}@wrightful.test`;
    const password = "signup-spec-pw-12345";
    const name = "Signup Spec";

    await page.goto("/signup");
    await expect(
      page.getByRole("heading", { name: /create your account/i }),
    ).toBeVisible();

    await page.getByLabel(/^name$/i).fill(name);
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole("button", { name: /create account/i }).click();

    // Successful sign-up navigates off /signup. Better Auth returns a
    // session cookie inline; the form's onSubmit then calls navigate(...).
    await page.waitForURL((url) => !url.pathname.startsWith("/signup"), {
      timeout: 15_000,
    });
    await expect(page).not.toHaveURL(/\/signup/);

    // The user has no team yet, so the dashboard's onboarding flow should
    // surface the "create your first team" form. The exact landing varies
    // by implementation; assert on the negative + that we're authed.
    await page.goto("/");
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("signup form validates password policy client-side (no auth call)", async ({
    page,
  }) => {
    await page.goto("/signup");
    await page.getByLabel(/^name$/i).fill("Whoever");
    await page.getByLabel(/email/i).fill(`signup-bad-${Date.now()}@x.test`);
    // Too short — fails the LoginForm's PASSWORD_MIN check.
    await page.getByLabel(/password/i).fill("short1");
    await page.getByRole("button", { name: /create account/i }).click();

    await expect(page.getByRole("alert")).toContainText(
      /at least 12 characters and include a number/i,
    );
    // Stayed on /signup.
    await expect(page).toHaveURL(/\/signup/);
  });

  test("signing up with the suite's primary user's email surfaces a server error", async ({
    page,
  }) => {
    await page.goto("/signup");
    await page.getByLabel(/^name$/i).fill("Duplicate");
    // The primary user was seeded by bootDashboard; this email is already
    // taken. Better Auth should return an error from the server.
    await page.getByLabel(/email/i).fill(fixture.email);
    await page.getByLabel(/password/i).fill("never-going-to-work-1");
    await page.getByRole("button", { name: /create account/i }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/signup/);
  });
});
