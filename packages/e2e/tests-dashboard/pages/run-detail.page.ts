import { type Locator, type Page, expect } from "@playwright/test";

/**
 * Page object for `/t/:teamSlug/p/:projectSlug/runs/:runId`.
 *
 * Test-row anchors carry `data-testid="test-row-link"`; the back-link to
 * the project page is recovered by URL-suffix because the back-link is
 * generic chrome that doesn't (yet) have its own testid.
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
    this.testRowLinks = page.getByTestId("test-row-link");
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
