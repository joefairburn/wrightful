# 2026-07-12 — Seed suite emits Console + Network trace data

## What changed

`pnpm setup:local` (and `pnpm fixtures:generate`) now seed traces that carry
**Console** and **Network** entries, so the custom trace viewer's Console and
Network tabs have real data to render. Previously the seed Playwright specs
drove static `page.setContent` pages (no network requests, no console output)
and the config recorded traces only `retain-on-failure` — so the all-green
scenarios shipped no traces at all, and the ones that did exist had empty
Console/Network tabs.

Two changes:

1. **New fake storefront** (`apps/dashboard/scripts/seed/playwright/mock-site.ts`).
   A `gotoShop(page)` helper installs Playwright route handlers for a fake
   origin (`https://shop.wrightful.test`) and navigates to it. Everything is
   served from route handlers — no live server or internet needed — so each
   trace gets a document request plus CSS/JS/image sub-resources, several
   GET/POST `fetch` calls (with JSON request bodies), a deliberate `404`
   (`/api/recommendations`) for a failed Network row, and console output at
   `log`/`info`/`debug`/`warn`/`error` levels.

2. **`trace: "on"`** in `scripts/seed/playwright/playwright.config.ts` (was
   `retain-on-failure`) so passing tests also produce a trace — otherwise the
   green scenarios (01-main-green, 03-main-historical) would still ship none.
   Video/screenshot stay `retain-on-failure`/`only-on-failure`.

The seed specs (`cart.spec.ts`, `checkout.spec.ts`, and the failing
`blocks expired promo codes` case in `flaky.spec.ts`) now call `gotoShop`
instead of `setContent`, keeping the same test names, tags, and pass/fail
outcomes so dashboard filters and history stay stable.

## Details

| File                                           | Change                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `scripts/seed/playwright/mock-site.ts`         | **New** — `gotoShop(page)` + fake storefront (HTML/CSS/JS/PNG + JSON API) served via `page.route` |
| `scripts/seed/playwright/playwright.config.ts` | `trace: "retain-on-failure"` → `"on"`                                                             |
| `scripts/seed/playwright/cart.spec.ts`         | `setContent` → `gotoShop`                                                                         |
| `scripts/seed/playwright/checkout.spec.ts`     | `setContent` → `gotoShop`                                                                         |
| `scripts/seed/playwright/flaky.spec.ts`        | `blocks expired promo codes` drives the shop (promo flow) before the deliberate failure           |
| `scripts/seed/playwright/README.md`            | Documents the mock site + `trace: "on"`                                                           |

`visual-regression.spec.ts` is left untouched — its `setContent` render is
compared pixel-for-pixel against a committed baseline.

**Trade-off:** `trace: "on"` means every seed test uploads a `trace.zip`
(previously only failures did), so `setup:local` / `fixtures:generate` write
more artifacts to R2 and take somewhat longer. That's the intended cost — the
seed suite exists to populate the demo dashboard with browsable trace data.

## Verification

- `pnpm check` — my four changed files are clean (format + lint + type-check).
  The 3 remaining format warnings (`timeline.tsx`, two worklogs) are
  pre-existing on this branch, untouched here.
- Ran the green specs against no ingest creds (reporter no-ops):
  `npx playwright test --config scripts/seed/playwright/playwright.config.ts cart checkout`
  → 5 passed, 1 skipped, all producing `trace.zip`.
- Unpacked a passing trace: 8 Network requests (document + css/js/png +
  `/api/products`, `/api/session`, `/api/cart`, `/api/recommendations` 404)
  and 7 Console messages across levels.
- Ran `WRIGHTFUL_FIXTURE_FAILURES=1 … flaky.spec` → 1 failed
  (`blocks expired promo codes`) + 1 flaky, unchanged outcomes; the failing
  trace carries Console + Network entries alongside the assertion error.
