import { expect, test } from "@playwright/test";

import { readFixture } from "./helpers/fixture";

const fixture = readFixture();
const KEYS_PATH = `/settings/teams/${fixture.teamSlug}/p/${fixture.projectSlug}/keys`;

test.describe("API keys settings", () => {
  test("mints a new key and reveals the plaintext exactly once", async ({
    page,
  }) => {
    await page.goto(KEYS_PATH);
    await expect(
      page.getByRole("heading", { name: /project settings/i }),
    ).toBeVisible();

    const label = `playwright-mint-${Date.now()}`;
    // The form's <Field>/<FieldLabel> uses Base UI's Field primitive.
    // Targeting `[name="label"]` is more reliable than getByLabel —
    // there are multiple nodes containing "Label" on this page (form
    // label + table header).
    await page.locator('input[name="label"]').fill(label);
    await page.getByRole("button", { name: /mint key/i }).click();

    // Reveal banner is the success Alert with the plaintext key in a <pre>.
    const reveal = page.getByText(
      /copy your new key now — it won't be shown again/i,
    );
    await expect(reveal).toBeVisible();
    const plaintext = await page.locator("pre").first().innerText();
    expect(plaintext.length).toBeGreaterThan(8);

    // The new row appears in the keys table with status "active".
    const row = page.locator("tr").filter({ hasText: label });
    await expect(row).toBeVisible();
    await expect(row.getByText(/active/i)).toBeVisible();

    // Reload: reveal cookie is one-shot (Max-Age=60 + cleared on next
    // load), so the plaintext must NOT reappear.
    await page.goto(KEYS_PATH);
    await expect(
      page.getByText(/copy your new key now — it won't be shown again/i),
    ).not.toBeVisible();
  });

  test("revokes a key and the status flips to 'revoked'", async ({ page }) => {
    // Seed a fresh key first so the revoke under test doesn't depend on
    // what other tests in the suite did.
    await page.goto(KEYS_PATH);
    const label = `playwright-revoke-${Date.now()}`;
    // The form's <Field>/<FieldLabel> uses Base UI's Field primitive.
    // Targeting `[name="label"]` is more reliable than getByLabel —
    // there are multiple nodes containing "Label" on this page (form
    // label + table header).
    await page.locator('input[name="label"]').fill(label);
    await page.getByRole("button", { name: /mint key/i }).click();

    const row = page.locator("tr").filter({ hasText: label });
    await expect(row).toBeVisible();
    await expect(row.getByText(/active/i)).toBeVisible();

    // Revoke. The button is inside an inline form; clicking submits it.
    await row.getByRole("button", { name: /^revoke$/i }).click();

    // After revoke + redirect, the same row shows "revoked" and no
    // Revoke button.
    const revokedRow = page.locator("tr").filter({ hasText: label });
    await expect(revokedRow.getByText(/revoked/i)).toBeVisible();
    await expect(
      revokedRow.getByRole("button", { name: /^revoke$/i }),
    ).toHaveCount(0);
  });
});
