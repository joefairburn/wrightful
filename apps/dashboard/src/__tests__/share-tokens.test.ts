import { describe, expect, it, vi } from "vite-plus/test";

// Deterministic secret so sign/verify share a key without the void runtime.
vi.mock("void/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long-000",
    SHARE_TOKEN_SECRET: undefined,
  },
}));

const { signShareToken, verifyShareToken, shareTokenHash, shareRunPath } =
  await import("@/lib/share-tokens");

const payload = { runId: "run_1", projectId: "proj_1", teamId: "team_1" };

describe("share token sign/verify", () => {
  it("round-trips the payload", async () => {
    const { token } = await signShareToken(payload);
    expect(await verifyShareToken(token)).toEqual(payload);
  });

  it("rejects a tampered token", async () => {
    const { token } = await signShareToken(payload);
    expect(await verifyShareToken(`${token}x`)).toBeNull();
    expect(await verifyShareToken("not-a-token")).toBeNull();
    expect(await verifyShareToken("")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { token } = await signShareToken(payload, -10);
    expect(await verifyShareToken(token)).toBeNull();
  });

  it("reports the expiry it signed", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { expiresAt } = await signShareToken(payload, 3600);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600);
  });
});

describe("shareTokenHash", () => {
  it("is a stable 64-char hex digest", async () => {
    const { token } = await signShareToken(payload);
    const h = await shareTokenHash(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await shareTokenHash(token)).toBe(h);
  });
});

describe("shareRunPath", () => {
  it("owns the public URL shape", () => {
    expect(shareRunPath("abc.def")).toBe("/share/run/abc.def");
  });
});
