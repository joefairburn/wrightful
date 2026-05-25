import { expect, test } from "@playwright/test";

// Visual regression seeder. NOT a test — engineered to fail every run so
// the demo dashboard ends up with a populated visual-diff entry. Lives
// alongside `make-visual-baseline.mjs`, which renders the committed
// baseline (`visual-regression.spec.ts-snapshots/landing.png`) from
// V1_HTML; this spec renders V2_HTML. V1→V2 has three intentional deltas —
// headline text, button colour, and a price change — so the diff viewer
// surfaces realistic, semantically meaningful pixel regions rather than a
// wall of solid colour.
//
// Gated on `WRIGHTFUL_FIXTURE_FAILURES=1` so the all-green scenarios in
// `upload-fixtures.mjs` (01-main-green, 03-main-historical) skip it. The
// failures scenario (02-feature-flaky) runs it and seeds a working visual
// diff into the demo dashboard automatically.
//
// CAUTION: do not run this file with `--update-snapshots`; it would
// overwrite the intentionally-stale baseline. Rerun
// `node make-visual-baseline.mjs` instead — that's the single source of
// truth for V1.

const INCLUDE_FAILURES = process.env.WRIGHTFUL_FIXTURE_FAILURES === "1";

// Keep this in sync with V1_HTML in
// `scripts/make-visual-baseline.mjs` — V2 differs from V1 in only the
// places listed in the file header. Don't restyle one without updating the
// other or the diff loses its semantic meaning.
const V2_HTML = `<!doctype html>
<html><head><style>
  body { margin: 0; font-family: -apple-system, "Segoe UI", system-ui, Arial, sans-serif; color: #0f172a; }
  .nav { background: #0f172a; color: #fff; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }
  .logo { font-weight: 700; font-size: 16px; letter-spacing: -0.01em; }
  .nav-links { display: flex; gap: 18px; font-size: 13px; opacity: 0.72; }
  .hero { padding: 36px 24px 32px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
  .headline { font-size: 28px; font-weight: 700; margin: 0 0 6px; letter-spacing: -0.02em; }
  .subtitle { font-size: 14px; color: #64748b; margin: 0 0 18px; }
  /* DELTA #2: button colour was #2563eb (blue) in V1, now #16a34a (green). */
  .cta { background: #16a34a; color: #fff; border: 0; padding: 10px 20px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .pricing { padding: 20px 24px; display: flex; gap: 12px; }
  .price-card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px; flex: 1; background: #fff; }
  .plan { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 4px; }
  .price { font-size: 22px; font-weight: 700; margin: 0; }
</style></head>
<body>
  <div id="page" style="width:640px">
    <div class="nav">
      <div class="logo">Acme</div>
      <div class="nav-links"><span>Home</span><span>Pricing</span><span>Docs</span></div>
    </div>
    <div class="hero">
      <!-- DELTA #1: was "Build faster with Acme" in V1. -->
      <h1 class="headline">Ship faster with Acme</h1>
      <p class="subtitle">Modern tooling for modern teams.</p>
      <button class="cta">Get started</button>
    </div>
    <div class="pricing">
      <div class="price-card">
        <p class="plan">Starter</p>
        <!-- DELTA #3: was $29/mo in V1. -->
        <p class="price">$39/mo</p>
      </div>
      <div class="price-card">
        <p class="plan">Pro</p>
        <p class="price">$99/mo</p>
      </div>
    </div>
  </div>
</body></html>`;

test.describe("Landing page visual regression", () => {
  test.skip(!INCLUDE_FAILURES, "only runs in the failures scenario");

  test("hero copy + pricing match baseline @visual", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 460 });
    await page.setContent(V2_HTML);
    await expect(page.locator("#page")).toHaveScreenshot("landing.png");
  });
});
