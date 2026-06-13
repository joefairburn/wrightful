import { base64urlEncode, timingSafeEqualHex } from "@/lib/token-crypto";

/**
 * GitHub App authentication primitives (WebCrypto-only, Workers-compatible):
 * mint the App JWT, exchange it for an installation token, and verify inbound
 * webhook signatures. The check-run posting logic that consumes these lives in
 * `github-checks.ts`.
 */

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "wrightful-dashboard";
const REQUEST_TIMEOUT_MS = 10_000;

const encoder = new TextEncoder();

/** Owner segment of a `"owner/name"` repo string, or null if malformed. PURE. */
export function parseRepoOwner(repo: string | null | undefined): string | null {
  if (!repo) return null;
  const owner = repo.split("/")[0]?.trim();
  return owner ? owner : null;
}

/** Lowercase hex of a byte array. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Strip a PEM envelope and base64-decode the body to DER bytes. */
function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Mint a short-lived GitHub App JWT (RS256) for App-level API calls. `iat` is
 * back-dated 60s to tolerate clock skew; `exp` is +9min (GitHub caps the App
 * JWT lifetime at 10 minutes). `privateKeyPem` must be PKCS#8 (see env.ts).
 */
export async function mintAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds: number,
): Promise<string> {
  const header = base64urlEncode(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const payload = base64urlEncode(
    encoder.encode(
      JSON.stringify({
        iat: nowSeconds - 60,
        exp: nowSeconds + 540,
        iss: appId,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}

/** Fetch against the GitHub API with the standard App headers + a timeout. */
export async function githubFetch(
  path: string,
  init: RequestInit,
  bearer: string,
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${bearer}`,
      "User-Agent": USER_AGENT,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * Exchange the App JWT for a short-lived installation access token, which is
 * what actually authorizes repo-scoped calls (posting a check run). Throws on a
 * non-2xx response so the caller's best-effort wrapper logs and moves on.
 */
export async function mintInstallationToken(
  appId: string,
  privateKeyPem: string,
  installationId: number,
  nowSeconds: number,
): Promise<string> {
  const jwt = await mintAppJwt(appId, privateKeyPem, nowSeconds);
  const response = await githubFetch(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST" },
    jwt,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub installation-token exchange failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    token?: string;
  };
  if (!body.token)
    throw new Error("GitHub installation-token response had no token");
  return body.token;
}

/** Resolve the account login an installation is installed on (the repo owner). */
export async function fetchInstallationAccountLogin(
  appId: string,
  privateKeyPem: string,
  installationId: number,
  nowSeconds: number,
): Promise<string | null> {
  const jwt = await mintAppJwt(appId, privateKeyPem, nowSeconds);
  const response = await githubFetch(
    `/app/installations/${installationId}`,
    { method: "GET" },
    jwt,
  );
  if (!response.ok) return null;
  const body = (await response.json().catch(() => ({}))) as {
    account?: { login?: string };
  };
  return body.account?.login ?? null;
}

/**
 * Verify a GitHub webhook's `X-Hub-Signature-256` (HMAC-SHA256 of the raw body
 * keyed by the webhook secret). Constant-time compare. Returns false on a
 * missing/malformed header so an unsigned request is simply rejected.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return timingSafeEqualHex(bytesToHex(new Uint8Array(mac)), provided);
}
