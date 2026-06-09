import { test, expect } from "@playwright/test";
import { pace } from "./pace";

// Optional per-test delay so `seed:stream` runs slow enough to watch live.
test.afterEach(pace);

const CART_PAGE = `
<!doctype html>
<html>
  <body>
    <h1>Shopping cart</h1>
    <ul id="items"></ul>
    <button id="add">Add item</button>
    <button id="remove">Remove last</button>
    <script>
      const items = document.getElementById("items");
      document.getElementById("add").addEventListener("click", () => {
        const li = document.createElement("li");
        li.textContent = "Widget " + (items.children.length + 1);
        items.appendChild(li);
      });
      document.getElementById("remove").addEventListener("click", () => {
        if (items.lastChild) items.removeChild(items.lastChild);
      });
    </script>
  </body>
</html>
`;

test.describe("Shopping cart", () => {
  test("adds item to basket @smoke @cart", async ({ page }) => {
    await page.setContent(CART_PAGE);
    await page.click("#add");
    await expect(page.locator("#items li")).toHaveCount(1);
  });

  test("removes item from basket @cart", async ({ page }) => {
    await page.setContent(CART_PAGE);
    await page.click("#add");
    await page.click("#add");
    await page.click("#remove");
    await expect(page.locator("#items li")).toHaveCount(1);
  });

  test("persists basket across interactions @cart @persistence", async ({
    page,
  }) => {
    await page.setContent(CART_PAGE);
    await page.click("#add");
    await page.click("#add");
    await page.click("#add");
    await expect(page.locator("#items li")).toHaveCount(3);
  });
});
