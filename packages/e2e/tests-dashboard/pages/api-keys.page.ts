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
    await expect(this.revealAlert).toBeVisible();
    // Plaintext lives in a <pre> *inside* the success alert; scope the
    // selector so an unrelated <pre> elsewhere on the page can't shadow it.
    const alertContainer = this.revealAlert.locator(
      "xpath=ancestor::*[@data-slot='alert' or contains(@class,'rounded')][1]",
    );
    const plaintext = await alertContainer.locator("pre").first().innerText();
    return plaintext;
  }

  rowFor(label: string): Locator {
    return this.page.locator("tr").filter({ hasText: label });
  }

  async revoke(label: string): Promise<void> {
    const row = this.rowFor(label);
    await row.getByRole("button", { name: /^revoke$/i }).click();
  }
}
