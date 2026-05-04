/**
 * axe-core accessibility scans on the highest-traffic pages.
 *
 * Policy: fail only on serious + critical impact violations. minor /
 * moderate are surfaced in the test report but don't block CI — they
 * tend to be advisory (e.g. low-contrast on muted-foreground text in
 * dark mode) and the cost of suppressing each one outweighs the value
 * of merge-blocking on them.
 *
 * If a real serious/critical violation lands, the right fix is in the
 * affected component; do NOT suppress here unless there's a documented
 * reason and a TODO with a tracking link.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();

// TODO(a11y/color-contrast): The dashboard's muted-foreground tokens (used
// in row metadata, breadcrumb labels, table headers) fail WCAG AA contrast
// at 4.5:1 in some surfaces. Tracked separately — a fix needs design-token
// rebalancing across light + dark modes. Keep all OTHER serious/critical
// rules active here; this is the only blanket suppression.
const SUPPRESSED_RULES = ["color-contrast"];

async function scanSerious(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .disableRules(SUPPRESSED_RULES)
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  if (blocking.length > 0) {
    const summary = blocking
      .map(
        (v) =>
          `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node${
            v.nodes.length === 1 ? "" : "s"
          })`,
      )
      .join("\n");
    throw new Error(
      `axe-core found ${blocking.length} serious/critical violation(s) on ${label}:\n${summary}`,
    );
  }
  expect(blocking).toEqual([]);
}

test.describe("Accessibility (axe-core, serious/critical only)", () => {
  // Login is the first page anonymous users see — accessibility regressions
  // here block sign-in entirely. Drop storageState to render the form.
  test.describe("login (anonymous)", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("login page has no serious/critical violations", async ({ page }) => {
      await page.goto("/login");
      await scanSerious(page, "/login");
    });
  });

  test("runs-list page has no serious/critical violations", async ({
    page,
  }) => {
    await page.goto(`/t/${fixture.teamSlug}/p/${fixture.projectSlug}`);
    await expect(
      page.getByRole("heading", { name: /all runs/i }),
    ).toBeVisible();
    await scanSerious(page, `/t/${fixture.teamSlug}/p/${fixture.projectSlug}`);
  });

  test("run-detail page has no serious/critical violations", async ({
    page,
  }) => {
    await page.goto(`/t/${fixture.teamSlug}/p/${fixture.projectSlug}`);
    const firstRun = page
      .locator(
        `a[href*="/t/${fixture.teamSlug}/p/${fixture.projectSlug}/runs/"]`,
      )
      .first();
    const href = await firstRun.getAttribute("href");
    if (!href) throw new Error("no seeded run on the project page");
    await page.goto(href);
    await scanSerious(page, `run-detail`);
  });
});
