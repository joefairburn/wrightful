import { type Locator, type Page, expect } from "@playwright/test";

/**
 * Page object for `/t/:teamSlug/p/:projectSlug/runs/:runId`.
 *
 * Test-row anchors are recovered via the labelled list (`<ul
 * aria-label="Tests in foo.spec.ts">`) — leans on real a11y instead
 * of a test-only attribute. The back-link is recovered by URL suffix
 * since it's generic chrome.
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
    // Scope to the labelled test lists so we don't pick up unrelated
    // anchors elsewhere on the page.
    this.testRowLinks = page
      .getByRole("list", { name: /^Tests in / })
      .getByRole("link");
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
