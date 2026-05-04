import { expect, test } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();

test.describe("Logout", () => {
  test("user menu → Log out lands on /login and clears the session", async ({
    page,
    context,
  }) => {
    await page.goto(`/t/${fixture.teamSlug}/p/${fixture.projectSlug}`);
    // Wait for the client island to hydrate — the popover trigger is a
    // client component and the click is a no-op until it's ready.
    await page.waitForLoadState("networkidle");

    // The sidebar user menu is keyed by the user's display name.
    const trigger = page.getByLabel(/account menu for/i);
    await trigger.click();

    // Base UI renders the popover content into a portal; scope the
    // search to the popup rather than the whole document so the
    // "Log out" text in the menu is found, not any incidental
    // sidebar copy.
    const logoutBtn = page.getByRole("button", { name: /log out/i });
    await logoutBtn.waitFor({ state: "visible", timeout: 10_000 });
    await logoutBtn.click();

    await page.waitForURL((url) => url.pathname === "/login", {
      timeout: 10_000,
    });
    await expect(page).toHaveURL(/\/login/);

    // Cookie was cleared: a fresh navigation to the team URL should bounce
    // to /login again, not render the project page.
    await page.goto(`/t/${fixture.teamSlug}/p/${fixture.projectSlug}`);
    await expect(page).toHaveURL(/\/login/);

    // And the storageState in the *context* no longer carries the
    // session token — covers the "did the cookie actually clear, or did
    // the redirect just hide it" failure mode.
    const stateCookies = await context.cookies();
    const sessionCookie = stateCookies.find(
      (c) => /session/i.test(c.name) || /better-auth/i.test(c.name),
    );
    // Either no session cookie remains, or it has an empty/expired value.
    expect(
      !sessionCookie ||
        sessionCookie.value === "" ||
        sessionCookie.expires === 0,
    ).toBe(true);
  });
});
