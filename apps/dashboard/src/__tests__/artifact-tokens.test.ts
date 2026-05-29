import { describe, it, expect, vi } from "vite-plus/test";

// Deterministic secret so sign/verify share a key without the void runtime.
vi.mock("void/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long-000",
    ARTIFACT_TOKEN_SECRET: undefined,
  },
}));

const { signArtifactToken, verifyArtifactToken } =
  await import("@/lib/artifact-tokens");

const payload = {
  r2Key: "t/team/p/proj/runs/r/tr/a.png",
  contentType: "image/png",
};

/**
 * Guards the HMAC artifact-download token: a valid token round-trips, a tampered
 * payload or expired token is rejected. This is the capability that gates
 * unauthenticated artifact reads, so its verify path must stay strict.
 */
describe("artifact download tokens", () => {
  it("round-trips a valid token", async () => {
    const token = await signArtifactToken(payload);
    expect(await verifyArtifactToken(token)).toEqual(payload);
  });

  it("rejects a payload tampered after signing", async () => {
    const token = await signArtifactToken(payload);
    const sig = token.slice(token.indexOf(".") + 1);
    // Re-encode a different r2Key but reuse the original signature.
    const forgedBody = Buffer.from(
      JSON.stringify({
        r2Key: "t/attacker/p/secret/runs/x/tr/leak.bin",
        contentType: "image/png",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    expect(await verifyArtifactToken(`${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const expired = await signArtifactToken(payload, -10);
    expect(await verifyArtifactToken(expired)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyArtifactToken("garbage")).toBeNull();
    expect(await verifyArtifactToken("")).toBeNull();
    expect(await verifyArtifactToken("a.b.c")).toBeNull();
  });
});
