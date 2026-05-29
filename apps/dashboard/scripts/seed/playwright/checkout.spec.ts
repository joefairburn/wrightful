import { test, expect } from "@playwright/test";

const CHECKOUT_PAGE = (opts: { promoValid?: boolean } = {}) => `
<!doctype html>
<html>
  <body>
    <h1>Checkout</h1>
    <input id="promo" placeholder="Promo code" />
    <button id="apply">Apply promo</button>
    <div id="discount">No discount</div>
    <button id="pay">Pay</button>
    <div id="status"></div>
    <script>
      const promoValid = ${opts.promoValid !== false};
      document.getElementById("apply").addEventListener("click", () => {
        const code = document.getElementById("promo").value;
        document.getElementById("discount").textContent =
          (promoValid && code) ? "10% off" : "No discount";
      });
      document.getElementById("pay").addEventListener("click", () => {
        document.getElementById("status").textContent = "Paid";
      });
    </script>
  </body>
</html>
`;

test.describe("Checkout", () => {
  test("completes with credit card @smoke @checkout", async ({ page }) => {
    await page.setContent(CHECKOUT_PAGE());
    await page.click("#pay");
    await expect(page.locator("#status")).toHaveText("Paid");
  });

  test("applies promo code @checkout", async ({ page }) => {
    await page.setContent(CHECKOUT_PAGE());
    await page.fill("#promo", "SAVE10");
    await page.click("#apply");
    await expect(page.locator("#discount")).toContainText("10% off");
  });

  test.skip("shows confirmation email copy @checkout @fixme", async ({
    page,
  }) => {
    await page.setContent(CHECKOUT_PAGE());
    await expect(page.locator("#confirmation")).toBeVisible();
  });
});
