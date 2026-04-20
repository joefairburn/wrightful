/**
 * Fetch the GitHub org logins the authenticated user is a member of, using
 * the access token stored in `account.accessToken` from Better Auth's GitHub
 * provider. Requires the `read:org` OAuth scope.
 *
 * Returns lowercased `login` slugs so membership checks are case-insensitive.
 * Throws on non-2xx responses — callers should treat that as "could not
 * verify" and fail closed for whitelist enforcement.
 */
export async function fetchUserOrgLogins(
  accessToken: string,
): Promise<string[]> {
  const res = await fetch("https://api.github.com/user/orgs", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "wrightful",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub /user/orgs returned ${res.status}: ${await res.text()}`,
    );
  }
  const orgs = (await res.json()) as { login: string }[];
  return orgs.map((o) => o.login.toLowerCase());
}
