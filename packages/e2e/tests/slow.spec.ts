import { test, expect } from "@playwright/test";

// Temporary spec — artificially slow tests so the dashboard's pending/streaming
// state is visible while the run is in flight. Delete when done watching.

test.describe.configure({ mode: "serial" });

test.describe("Slow streaming demo", () => {
  test("slow page load #1", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(8000);
    await expect(page).toHaveTitle(/Playwright/);
  });

  test("slow page load #2", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(8000);
    const nav = page.locator("nav");
    await expect(nav).toBeVisible();
  });

  test("slow docs load", async ({ page }) => {
    await page.goto("/docs/intro");
    await page.waitForTimeout(8000);
    await expect(page.locator("h1")).toBeVisible();
  });

  test("intentional failure", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(8000);
    await expect(page.locator("#definitely-does-not-exist")).toBeVisible({
      timeout: 2000,
    });
  });

  test("slow final check", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(8000);
    await expect(page).toHaveTitle(/Playwright/);
  });
});
