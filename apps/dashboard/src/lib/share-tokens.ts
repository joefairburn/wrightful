import { z } from "zod";
import { env } from "void/env";
import { resolveShareTokenSecret } from "@/lib/config";
import {
  base64urlDecode,
  base64urlEncode,
  sha256Hex,
  timingSafeEqualBytes,
} from "@/lib/token-crypto";

/**
 * Public run-share tokens — the capability behind `/share/run/:token`.
 *
 * Structurally a sibling of `artifact-tokens.ts`: an HMAC-signed payload that
 * the public loader verifies WITHOUT a session, then launders the (already
 * authenticity-proven) ids into a `TenantScope` via `makeTenantScope`. The
 * difference is lifetime + revocability: share links are long-lived (default 30
 * days) and backed by a `runShares` row so a specific link can be revoked
 * before expiry (the loader checks `revokedAt` by `shareTokenHash`).
 */

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface ShareRunPayload {
  runId: string;
  projectId: string;
  teamId: string;
}

const signedPayloadSchema = z.object({
  runId: z.string(),
  projectId: z.string(),
  teamId: z.string(),
  /** Unix-seconds expiry. */
  exp: z.number(),
});

async function getKey(): Promise<CryptoKey> {
  const secret = resolveShareTokenSecret(env);
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The one place that owns the public share URL shape. */
export function shareRunPath(token: string): string {
  return `/share/run/${token}`;
}

/** SHA-256 of a token — the `runShares.tokenHash` lookup/revocation key. */
export async function shareTokenHash(token: string): Promise<string> {
  return sha256Hex(token);
}

export async function signShareToken(
  payload: ShareRunPayload,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signed: z.infer<typeof signedPayloadSchema> = {
    runId: payload.runId,
    projectId: payload.projectId,
    teamId: payload.teamId,
    exp: expiresAt,
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
  return {
    token: `${body}.${base64urlEncode(new Uint8Array(sig))}`,
    expiresAt,
  };
}

/**
 * Verify a share token's HMAC + expiry and return its payload, or null. This is
 * the STATELESS authenticity check; per-link revocation is a separate
 * `runShares.revokedAt` lookup the loader does on top (so a revoked-but-unexpired
 * token still fails verification at the row level).
 */
export async function verifyShareToken(
  token: string,
): Promise<ShareRunPayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const provided = base64urlDecode(token.slice(dot + 1));
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
  return {
    runId: parsed.runId,
    projectId: parsed.projectId,
    teamId: parsed.teamId,
  };
}
