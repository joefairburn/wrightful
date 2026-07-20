import { env } from "void/env";
import { githubFetch, mintAppJwt } from "@/lib/github-http";

/**
 * GitHub App authentication — the env-reading layer: read the App's identity,
 * mint the App JWT, exchange it for installation-scoped access. The env-free
 * HTTP/crypto primitives it composes (`githubFetch`, `mintAppJwt`, webhook
 * verification) live in `github-http.ts` so config-time modules can import them;
 * this module is request-time only (top-level `void/env` import). The check-run
 * posting logic that consumes these lives in `github-checks.ts`.
 */

/**
 * The GitHub App's env-sourced identity (App id + PKCS#8 private key). Reading
 * the creds HERE — the module that owns App auth — instead of threading them
 * through every call site means the only place that knows they come from env
 * (and might be absent) is this function. The App-authenticated entry points
 * ({@link mintInstallationToken} / {@link fetchInstallationAccountLogin}) call
 * it so their callers shrink to a single `installationId`. Callers gate on
 * `githubAppEnabled(env)` upstream, so the throw is unreachable in practice but
 * keeps the types honest (the env keys are optional).
 */
function appCredentials(): { appId: string; privateKeyPem: string } {
  const appId = env.GITHUB_APP_ID;
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKeyPem) {
    throw new Error("GitHub App credentials are not configured");
  }
  return { appId, privateKeyPem };
}

/**
 * Exchange the App JWT for a short-lived installation access token, which is
 * what actually authorizes repo-scoped calls (posting a check run). Reads the
 * App creds + JWT clock internally (see {@link appCredentials}); the caller
 * supplies only the `installationId`. Throws on a non-2xx response so the
 * caller's best-effort wrapper logs and moves on.
 */
export async function mintInstallationToken(
  installationId: number,
): Promise<string> {
  const { appId, privateKeyPem } = appCredentials();
  const jwt = await mintAppJwt(
    appId,
    privateKeyPem,
    Math.floor(Date.now() / 1000),
  );
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

/**
 * Page cap for `/user/installations` (100 per page) when verifying ownership.
 * 10 × 100 = 1000 is far beyond any realistic count, and the loop stops early
 * on the first short page; a user past the ceiling can't be verified past it.
 */
const USER_INSTALLATIONS_MAX_PAGES = 10;

/**
 * Outcome of {@link verifyUserAdministersInstallation}: `"authorized"` (yes),
 * `"denied"` (GitHub listed the user's installations and this wasn't among
 * them), or `"error"` (transport failure, incl. an expired token → 401). The
 * callback maps each to a distinct leak-safe flash instead of a 500.
 */
export type InstallationOwnershipVerdict = "authorized" | "denied" | "error";

/**
 * PURE: does the user's accessible-installations list contain `installationId`?
 * Split out so the membership decision is unit-testable without a live token.
 */
export function userInstallationsInclude(
  installations: readonly { id?: number }[],
  installationId: number,
): boolean {
  return installations.some((i) => i.id === installationId);
}

/**
 * SECURITY (H1: GitHub App installation takeover / confused deputy). Prove the
 * signed-in user administers the GitHub account backing `installationId` before
 * the `/api/github/setup` callback persists the team↔installation link.
 *
 * Wrightful holds the App private key, so it can mint a token for any
 * installation id (see {@link mintInstallationToken}). The callback's only
 * inputs — `state` (team slug) and `installation_id` — are both attacker-
 * suppliable, so without this check a signed-in owner of a throwaway team could
 * claim any unlinked installation id (won by enumeration) and drive that org's
 * repos via merge-gating check runs (`postGithubRunSurfaces`).
 *
 * `GET /user/installations` (with the USER's OAuth token) returns exactly the
 * installations this user can manage — GitHub's own answer to "may this user
 * configure this installation", which we defer to instead of the query params.
 * Leak-safe and never throws: `"denied"` when not in the list, `"error"` on any
 * non-OK/parse/network failure. Do NOT downgrade this to trusting
 * `installation_id` — it's the sole barrier between an enumerable integer and
 * another org's merge gate.
 */
export async function verifyUserAdministersInstallation(
  userAccessToken: string,
  installationId: number,
): Promise<InstallationOwnershipVerdict> {
  try {
    for (let page = 1; page <= USER_INSTALLATIONS_MAX_PAGES; page++) {
      const response = await githubFetch(
        `/user/installations?per_page=100&page=${page}`,
        { method: "GET" },
        userAccessToken,
      );
      if (!response.ok) return "error";
      const body = (await response.json().catch(() => null)) as {
        installations?: { id?: number }[];
      } | null;
      if (!body) return "error";
      const installations = body.installations ?? [];
      if (userInstallationsInclude(installations, installationId)) {
        return "authorized";
      }
      // A short page means we've seen every accessible installation.
      if (installations.length < 100) break;
    }
    return "denied";
  } catch {
    return "error";
  }
}

/**
 * Resolve the account login an installation is installed on (the repo owner).
 * Reads the App creds + JWT clock internally; the caller supplies only the
 * `installationId`.
 */
export async function fetchInstallationAccountLogin(
  installationId: number,
): Promise<string | null> {
  const { appId, privateKeyPem } = appCredentials();
  const jwt = await mintAppJwt(
    appId,
    privateKeyPem,
    Math.floor(Date.now() / 1000),
  );
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
