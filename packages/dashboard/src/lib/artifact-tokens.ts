import { env } from "cloudflare:workers";

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array | null {
  try {
    const padded = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4;
    const binary = atob(pad ? padded + "=".repeat(4 - pad) : padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function getKey(): Promise<CryptoKey> {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Mint a short-lived token authorising a GET of `/api/artifacts/:artifactId/download`.
 * The token is HMAC-SHA-256 of `${artifactId}.${expiresAtSec}` keyed by
 * `BETTER_AUTH_SECRET`, base64url-encoded. Only code that runs with access to
 * the secret (the Worker) can mint valid tokens.
 */
export async function signArtifactToken(
  artifactId: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const key = await getKey();
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${artifactId}.${expiresAt}`),
  );
  return `${expiresAt}.${base64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyArtifactToken(
  artifactId: string,
  token: string,
): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiresAtRaw = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  if (Math.floor(Date.now() / 1000) > expiresAt) return false;
  const provided = base64urlDecode(sigB64);
  if (!provided) return false;
  const key = await getKey();
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${artifactId}.${expiresAt}`),
  );
  return timingSafeEqual(new Uint8Array(expected), provided);
}
