import { type Locator, type Page, expect } from "@playwright/test";

/**
 * Page object for `/settings/teams/:slug/p/:slug/keys`. The mint form
 * uses a Base UI <FieldLabel> which doesn't always wire up cleanly to
 * Playwright's getByLabel; the input is targeted by `name` instead.
 */
export class ApiKeysPage {
  readonly page: Page;
  readonly teamSlug: string;
  readonly projectSlug: string;

  readonly settingsHeading: Locator;
  readonly labelInput: Locator;
  readonly mintButton: Locator;
  readonly revealAlert: Locator;

  constructor(page: Page, teamSlug: string, projectSlug: string) {
    this.page = page;
    this.teamSlug = teamSlug;
    this.projectSlug = projectSlug;

    this.settingsHeading = page.getByRole("heading", {
      name: /project settings/i,
    });
    this.labelInput = page.locator('input[name="label"]');
    this.mintButton = page.getByRole("button", { name: /mint key/i });
    this.revealAlert = page.getByText(
      /copy your new key now — it won't be shown again/i,
    );
  }

  get path(): string {
    return `/settings/teams/${this.teamSlug}/p/${this.projectSlug}/keys`;
  }

  async goto(): Promise<void> {
    await this.page.goto(this.path);
    await expect(this.settingsHeading).toBeVisible();
  }

  /** Mint a key with the given label. Returns the revealed plaintext. */
  async mint(label: string): Promise<string> {
    await this.labelInput.fill(label);
    await this.mintButton.click();
    // The success Alert renders as a `role="status"` live region; scope
    // the plaintext lookup to that container so an unrelated <pre>
    // elsewhere on the page can't shadow it. Filter by title text in
    // case any other status region happens to be live.
    const successAlert = this.page
      .getByRole("status")
      .filter({ hasText: /copy your new key now/i });
    await expect(successAlert).toBeVisible();
    return successAlert.locator("pre").innerText();
  }

  rowFor(label: string): Locator {
    return this.page.locator("tr").filter({ hasText: label });
  }

  async revoke(label: string): Promise<void> {
    const row = this.rowFor(label);
    await row.getByRole("button", { name: /^revoke$/i }).click();
  }
}
