import { expect, test } from "./fixtures";

test.describe("Logout", () => {
  test("user menu → Log out lands on /login and clears the session", async ({
    page,
    context,
    runsListPage,
  }) => {
    await runsListPage.goto();
    // Anchor on the trigger being visible (proves the client island has
    // hydrated). Better than `networkidle` — the dashboard has live
    // SyncedStateServer subscriptions that keep the network busy.
    await expect(runsListPage.userMenuTrigger).toBeVisible();

    await runsListPage.logout();
    await expect(page).toHaveURL(/\/login/);

    // Cookie was actually cleared, not just hidden by the redirect.
    await page.goto(runsListPage.path);
    await expect(page).toHaveURL(/\/login/);

    const stateCookies = await context.cookies();
    const sessionCookie = stateCookies.find(
      (c) => /session/i.test(c.name) || /better-auth/i.test(c.name),
    );
    expect(
      !sessionCookie ||
        sessionCookie.value === "" ||
        sessionCookie.expires === 0,
    ).toBe(true);
  });
});
