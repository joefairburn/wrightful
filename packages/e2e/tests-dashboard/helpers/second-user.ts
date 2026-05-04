/**
 * HTTP-driven setup for a second user + their own team/project/API key.
 * Used by `cross-tenant.spec.ts` to assert that User A's browser session
 * AND API key cannot reach User B's resources.
 *
 * Mirrors the same flow `bootDashboard` runs at suite start (sign-up via
 * Better Auth → form-POST to /settings/teams/new + projects/new + keys).
 * Kept in tests-dashboard because it's spec-specific — bootDashboard
 * stays scoped to the singleton "the suite's primary user" case.
 */
import type { APIRequestContext, APIResponse } from "@playwright/test";

const REVEAL_COOKIE = "wrightful_reveal_key";

/**
 * Playwright's APIResponse exposes multi-valued headers via headersArray().
 * Set-Cookie is the canonical multi-valued header — `headers()` returns
 * only the first one, which is wrong for sign-up flows that emit multiple.
 */
function readSetCookies(res: APIResponse): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value.split(";")[0]);
}

export interface SecondUserCreds {
  email: string;
  password: string;
  name: string;
  teamSlug: string;
  teamName: string;
  projectSlug: string;
  projectName: string;
}

export interface SecondUserFixture {
  sessionCookies: string[];
  apiKey: string;
  teamSlug: string;
  projectSlug: string;
}

export async function seedSecondUser(
  request: APIRequestContext,
  baseUrl: string,
  creds: SecondUserCreds,
): Promise<SecondUserFixture> {
  // Sign-up. Better Auth's CSRF guard 403s without an Origin header.
  const signupRes = await request.post("/api/auth/sign-up/email", {
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    data: { email: creds.email, password: creds.password, name: creds.name },
  });
  if (!signupRes.ok()) {
    throw new Error(
      `[second-user] sign-up failed (${signupRes.status()}): ${await signupRes.text()}`,
    );
  }
  const sessionCookies = readSetCookies(signupRes);
  if (sessionCookies.length === 0) {
    throw new Error("[second-user] sign-up returned no Set-Cookie");
  }
  const cookieHeader = sessionCookies.join("; ");

  // Team.
  const teamForm = new URLSearchParams({ name: creds.teamName }).toString();
  const teamRes = await request.post("/settings/teams/new", {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: baseUrl,
      Cookie: cookieHeader,
    },
    data: teamForm,
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (teamRes.status() !== 302) {
    throw new Error(
      `[second-user] team creation returned ${teamRes.status()}: ${await teamRes.text()}`,
    );
  }
  const teamLoc = teamRes.headers().location ?? "";
  if (!teamLoc.includes(`/settings/teams/${creds.teamSlug}`)) {
    throw new Error(
      `[second-user] team slug mismatch — Location was "${teamLoc}", expected slug "${creds.teamSlug}"`,
    );
  }

  // Project.
  const projectForm = new URLSearchParams({
    name: creds.projectName,
  }).toString();
  const projectRes = await request.post(
    `/settings/teams/${creds.teamSlug}/projects/new`,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: baseUrl,
        Cookie: cookieHeader,
      },
      data: projectForm,
      maxRedirects: 0,
      failOnStatusCode: false,
    },
  );
  if (projectRes.status() !== 302) {
    throw new Error(
      `[second-user] project creation returned ${projectRes.status()}: ${await projectRes.text()}`,
    );
  }

  // Key (with reveal cookie).
  const keyForm = new URLSearchParams({
    action: "create",
    label: "second-user-e2e",
  }).toString();
  const keyRes = await request.post(
    `/settings/teams/${creds.teamSlug}/p/${creds.projectSlug}/keys`,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: baseUrl,
        Cookie: cookieHeader,
      },
      data: keyForm,
      maxRedirects: 0,
      failOnStatusCode: false,
    },
  );
  if (keyRes.status() !== 302) {
    throw new Error(
      `[second-user] key creation returned ${keyRes.status()}: ${await keyRes.text()}`,
    );
  }
  let apiKey: string | undefined;
  for (const raw of readSetCookies(keyRes)) {
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    if (raw.slice(0, eq) === REVEAL_COOKIE) {
      const value = raw.slice(eq + 1);
      if (value) apiKey = decodeURIComponent(value);
    }
  }
  if (!apiKey) {
    throw new Error(
      "[second-user] key creation succeeded but reveal cookie missing",
    );
  }

  return {
    sessionCookies,
    apiKey,
    teamSlug: creds.teamSlug,
    projectSlug: creds.projectSlug,
  };
}
