import { z } from "zod";
import { env } from "void/env";
import {
  base64urlDecode,
  base64urlEncode,
  timingSafeEqualBytes,
} from "@/lib/token-crypto";

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Signed artifact-download token. Carries the R2 object key + content type
 * directly, so the download handler can stream the response without touching
 * the DB. A leaked token grants short-lived read on exactly one R2 object.
 */
export interface ArtifactDownloadPayload {
  /** R2 object key the caller is authorized to GET. */
  r2Key: string;
  /** Content-Type echoed to the client (and the trace viewer). */
  contentType: string;
}

const signedPayloadSchema = z.object({
  r2Key: z.string(),
  contentType: z.string(),
  /** Unix-seconds expiry timestamp. */
  exp: z.number(),
});

type SignedPayload = z.infer<typeof signedPayloadSchema>;

async function getKey(): Promise<CryptoKey> {
  // Prefer a dedicated artifact-token secret so these short-lived, broadly
  // minted download capabilities can be rotated independently of the session
  // secret. Falls back to BETTER_AUTH_SECRET when unset (backward compatible).
  const secret = env.ARTIFACT_TOKEN_SECRET ?? env.BETTER_AUTH_SECRET;
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

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
  if (!timingSafeEqualBytes(new Uint8Array(expected), provided)) return null;

  const bodyBytes = base64urlDecode(body);
  if (!bodyBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return null;
  }
  const result = signedPayloadSchema.safeParse(raw);
  if (!result.success) return null;
  const parsed = result.data;
  if (Math.floor(Date.now() / 1000) > parsed.exp) return null;
  return { r2Key: parsed.r2Key, contentType: parsed.contentType };
}
