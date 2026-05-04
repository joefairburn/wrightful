// Regenerates the committed baseline used by visual-regression.spec.ts.
//
// Renders V1_HTML below in a real Chromium via Playwright and writes the
// resulting screenshot to disk. The test spec renders V2_HTML, which
// differs from V1 in three intentional ways:
//
//   1. Hero headline text  — "Build faster" → "Ship faster"
//   2. CTA button colour   — #2563eb (blue) → #16a34a (green)
//   3. Starter pricing     — $29/mo → $39/mo
//
// V1 is the baseline because it's what the dashboard expects to see; V2
// is the "regression" the test catches. Keep this file's V1_HTML in sync
// with V2_HTML in the spec — only the lines listed above should differ.
//
// Usage:
//   node packages/dashboard/scripts/seed/playwright/make-visual-baseline.mjs
//
// You only need to rerun this if you've deliberately changed the V1
// markup, viewport size, or screenshot bounds.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const V1_HTML = `<!doctype html>
<html><head><style>
  body { margin: 0; font-family: -apple-system, "Segoe UI", system-ui, Arial, sans-serif; color: #0f172a; }
  .nav { background: #0f172a; color: #fff; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }
  .logo { font-weight: 700; font-size: 16px; letter-spacing: -0.01em; }
  .nav-links { display: flex; gap: 18px; font-size: 13px; opacity: 0.72; }
  .hero { padding: 36px 24px 32px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
  .headline { font-size: 28px; font-weight: 700; margin: 0 0 6px; letter-spacing: -0.02em; }
  .subtitle { font-size: 14px; color: #64748b; margin: 0 0 18px; }
  .cta { background: #2563eb; color: #fff; border: 0; padding: 10px 20px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
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
      <h1 class="headline">Build faster with Acme</h1>
      <p class="subtitle">Modern tooling for modern teams.</p>
      <button class="cta">Get started</button>
    </div>
    <div class="pricing">
      <div class="price-card">
        <p class="plan">Starter</p>
        <p class="price">$29/mo</p>
      </div>
      <div class="price-card">
        <p class="plan">Pro</p>
        <p class="price">$99/mo</p>
      </div>
    </div>
  </div>
</body></html>`;

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "./visual-regression.spec.ts-snapshots/landing.png");

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 640, height: 460 },
  });
  const page = await context.newPage();
  await page.setContent(V1_HTML);
  mkdirSync(dirname(out), { recursive: true });
  await page.locator("#page").screenshot({ path: out });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
