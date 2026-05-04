import { expect, test } from "./fixtures";

test.describe("API keys settings", () => {
  test("mints a new key and reveals the plaintext exactly once", async ({
    apiKeysPage,
  }) => {
    await apiKeysPage.goto();

    const label = `playwright-mint-${Date.now()}`;
    const plaintext = await apiKeysPage.mint(label);
    expect(plaintext.length).toBeGreaterThan(8);

    // The new row appears in the keys table with status "active".
    const row = apiKeysPage.rowFor(label);
    await expect(row).toBeVisible();
    await expect(row.getByText(/active/i)).toBeVisible();

    // Reload: reveal cookie is one-shot. Plaintext must NOT reappear.
    await apiKeysPage.goto();
    await expect(apiKeysPage.revealAlert).not.toBeVisible();
  });

  test("revokes a key and the status flips to 'revoked'", async ({
    apiKeysPage,
  }) => {
    await apiKeysPage.goto();
    const label = `playwright-revoke-${Date.now()}`;
    await apiKeysPage.mint(label);

    const row = apiKeysPage.rowFor(label);
    await expect(row.getByText(/active/i)).toBeVisible();

    await apiKeysPage.revoke(label);

    const revokedRow = apiKeysPage.rowFor(label);
    await expect(revokedRow.getByText(/revoked/i)).toBeVisible();
    await expect(
      revokedRow.getByRole("button", { name: /^revoke$/i }),
    ).toHaveCount(0);
  });
});
