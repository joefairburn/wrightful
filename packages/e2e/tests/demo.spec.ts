import { test, expect } from "@playwright/test";

test.describe("Demo test suite", () => {
  test("should load a page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Playwright/);
  });

  test("should have navigation", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("nav");
    await expect(nav).toBeVisible();
  });

  test("should have docs link", async ({ page }) => {
    await page.goto("/docs/intro");
    await expect(page.locator("h1")).toBeVisible();
  });
});
