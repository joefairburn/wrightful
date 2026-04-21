import { env } from "cloudflare:workers";

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Signed artifact-download token. Carries the R2 object key and content type
 * directly so `/api/artifacts/:id/download` can stream the response without
 * touching the tenant DB — a leaked token grants short-lived read on exactly
 * one R2 object and nothing else.
 *
 * Rationale: post-M3 the tenant-owned `artifacts` table lives inside the
 * team's Durable Object. Fetching the r2Key on every download would require
 * a DO RPC from the download handler; encoding it in the signed token
 * eliminates that hop.
 */
export interface ArtifactDownloadPayload {
  /** R2 object key that the caller is authorised to GET. */
  r2Key: string;
  /** Content-Type header echoed to the client (and to the trace viewer). */
  contentType: string;
}

interface SignedPayload extends ArtifactDownloadPayload {
  /** Unix-seconds expiry timestamp. */
  exp: number;
}

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
 * Mint a short-lived download token. The token format is
 * `${base64url(JSON(payload+exp))}.${base64url(HMAC)}` — payload embeds the
 * r2Key and contentType, so the download handler needs no DB lookup to serve
 * the response.
 */
export async function signArtifactToken(
  payload: ArtifactDownloadPayload,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const signed: SignedPayload = {
    r2Key: payload.r2Key,
    contentType: payload.contentType,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(signed)),
  );
  const key = await getKey();
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return `${body}.${base64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify a download token. Returns the decoded payload on success (so the
 * handler can stream from R2 using `r2Key`), or null on signature mismatch /
 * expiry / malformed token.
 */
export async function verifyArtifactToken(
  token: string,
): Promise<ArtifactDownloadPayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const provided = base64urlDecode(sigB64);
  if (!provided) return null;

  const key = await getKey();
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  if (!timingSafeEqual(new Uint8Array(expected), provided)) return null;

  const bodyBytes = base64urlDecode(body);
  if (!bodyBytes) return null;
  let parsed: SignedPayload;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as SignedPayload;
  } catch {
    return null;
  }
  if (
    typeof parsed.r2Key !== "string" ||
    typeof parsed.contentType !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    return null;
  }
  if (Math.floor(Date.now() / 1000) > parsed.exp) return null;
  return { r2Key: parsed.r2Key, contentType: parsed.contentType };
}
