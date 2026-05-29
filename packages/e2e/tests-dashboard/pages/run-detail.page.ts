import { type Locator, type Page, expect } from "@playwright/test";

/**
 * Page object for `/t/:teamSlug/p/:projectSlug/runs/:runId`.
 *
 * Test-row anchors are recovered by href suffix (`a[href*="/tests/"]`) —
 * every row in the `RunProgress` Tests tab links to
 * `…/runs/<runId>/tests/<id>`, and no other anchor on the page does. The
 * back-link is recovered by URL suffix since it's generic chrome.
 */
export class RunDetailPage {
  readonly page: Page;
  readonly teamSlug: string;
  readonly projectSlug: string;

  readonly testRowLinks: Locator;
  readonly attemptsHeading: Locator;

  constructor(page: Page, teamSlug: string, projectSlug: string) {
    this.page = page;
    this.teamSlug = teamSlug;
    this.projectSlug = projectSlug;
    // Each test row in the Tests tab (`RunProgress` → `TestRow`) renders as
    // a `<Link>` whose href is `…/runs/<runId>/tests/<id>?attempt=0`. Scope
    // to those anchors by href: no other anchor on the run-detail page
    // points at `/tests/` (tab links use `?tab=`, the branch/PR/commit pills
    // are external github.com links, and the history-chart points link to
    // `/runs/<id>` without `/tests/`).
    this.testRowLinks = page.locator('a[href*="/tests/"]');
    this.attemptsHeading = page.getByRole("heading", {
      name: /attempts & errors/i,
    });
  }

  pathFor(runId: string): string {
    return `/t/${this.teamSlug}/p/${this.projectSlug}/runs/${runId}`;
  }

  async goto(runId: string): Promise<void> {
    await this.page.goto(this.pathFor(runId));
  }

  /** Project-page back-link — the generic chrome anchor on every detail page. */
  backLink(): Locator {
    return this.page.locator(
      `a[href$="/t/${this.teamSlug}/p/${this.projectSlug}"]`,
    );
  }

  async clickFirstTest(): Promise<void> {
    const link = this.testRowLinks.first();
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click();
    await this.page.waitForURL(/\/tests\//, { timeout: 10_000 });
  }
}
