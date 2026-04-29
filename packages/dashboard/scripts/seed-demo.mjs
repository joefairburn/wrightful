// Bootstraps a demo user + team + project + API key on a running local dev
// server, by hitting the worker's HTTP endpoints just like a real user
// would.
//
// Not idempotent. Designed to run against fresh ControlDO state (no demo
// user, no demo team). If the demo user already exists, sign-in succeeds
// but team creation lands on a `demo-2`-suffixed slug and the script
// aborts with a clear error pointing at the recovery path. setup-local.mjs
// avoids hitting that case by probing the existing seed key first and
// only re-running this script when the key is stale or absent.
//
// Why HTTP rather than direct DO writes: ControlDO bindings are only
// available *inside* the worker. This script runs as a plain Node process
// from your terminal and has no `env.CONTROL`. Same shape as how the
// reporter ingests test data — POST to the worker, let it write to the DO.
//
// Required env: WRIGHTFUL_BASE_URL (e.g. http://localhost:5173). The dev
// server must be running and ALLOW_OPEN_SIGNUP=1 must be set in `.dev.vars`
// (setup-local.mjs handles both).
//
// Writes the resolved URL + API key to `.dev.vars.seed.json` so the
// fixture uploader can find them without copy-pasting.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

const DEMO_EMAIL = "demo@wrightful.local";
const DEMO_PASSWORD = "demo1234";
const DEMO_NAME = "Demo User";
const TEAM_NAME = "Demo";
const TEAM_SLUG = "demo";
const PROJECT_NAME = "Playwright";
const PROJECT_SLUG = "playwright";

const dashboardDir = new URL("..", import.meta.url);
const seedOutputPath = fileURLToPath(
  new URL(".dev.vars.seed.json", dashboardDir),
);
const QUIET = process.env.WRIGHTFUL_QUIET === "1";
const log = (...args) => {
  if (!QUIET) console.log(...args);
};

const baseUrl = process.env.WRIGHTFUL_BASE_URL;
if (!baseUrl) {
  console.error(pc.red("seed-demo.mjs requires WRIGHTFUL_BASE_URL to be set."));
  console.error(
    pc.dim("Run via `pnpm setup:local`, which starts the dev server first."),
  );
  process.exit(1);
}

/**
 * Parse a Set-Cookie header into a `name=value` pair (without attributes
 * like Path/HttpOnly/etc.) suitable for sending back as a Cookie header.
 *
 * Modern Node fetch returns a single combined `set-cookie` header — we use
 * `headers.getSetCookie()` (Node 20+) to get an array of individual cookies.
 *
 * @param {Response} res
 * @returns {string[]}
 */
function readSetCookies(res) {
  return res.headers.getSetCookie().map((raw) => raw.split(";")[0]);
}

/**
 * Issue an HTTP request, never following redirects. We need to read the
 * Set-Cookie + Location headers from intermediate redirects (e.g. team
 * creation 302s with the team slug, key creation 302s with the reveal
 * cookie).
 */
async function request(method, path, opts = {}) {
  const url = `${baseUrl}${path}`;
  const headers = {
    Accept: "application/json",
    // Better Auth's CSRF guard rejects requests with a missing/null Origin
    // (returns 403 `MISSING_OR_NULL_ORIGIN`). Our server-action handlers
    // don't enforce it, but Better Auth does — so always set it.
    Origin: baseUrl,
    ...(opts.cookies ? { Cookie: opts.cookies.join("; ") } : {}),
    ...(opts.headers ?? {}),
  };
  let body;
  if (opts.json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) {
      params.set(k, v);
    }
    body = params.toString();
  }
  const res = await fetch(url, { method, headers, body, redirect: "manual" });
  return res;
}

// ---------- 1. Sign up ----------
log(`${pc.dim("›")} signing up demo user…`);

const signup = await request("POST", "/api/auth/sign-up/email", {
  json: {
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    name: DEMO_NAME,
  },
});

let sessionCookies;
if (signup.ok) {
  sessionCookies = readSetCookies(signup);
} else if (signup.status === 422 || signup.status === 400) {
  // User likely already exists. Try sign-in instead.
  const body = await signup.text();
  if (!body.toLowerCase().includes("exist")) {
    console.error(
      pc.red(`signup failed (${signup.status}): ${body || "(empty body)"}`),
    );
    process.exit(1);
  }
  log(`${pc.dim("›")} demo user already exists — signing in`);
  const signin = await request("POST", "/api/auth/sign-in/email", {
    json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  if (!signin.ok) {
    console.error(
      pc.red(
        `sign-in failed (${signin.status}): ${(await signin.text()) || "(empty body)"}`,
      ),
    );
    process.exit(1);
  }
  sessionCookies = readSetCookies(signin);
} else if (signup.status === 403) {
  const body = await signup.text();
  if (body.includes("Signup is disabled")) {
    console.error(
      pc.red(
        "signup is disabled on this dashboard. Set ALLOW_OPEN_SIGNUP=1 in .dev.vars and restart the dev server.",
      ),
    );
  } else {
    console.error(pc.red(`signup rejected (403): ${body || "(empty body)"}`));
  }
  process.exit(1);
} else {
  console.error(
    pc.red(
      `signup failed (${signup.status}): ${(await signup.text()) || "(empty body)"}`,
    ),
  );
  process.exit(1);
}

if (sessionCookies.length === 0) {
  console.error(
    pc.red("auth response did not set a session cookie — aborting."),
  );
  process.exit(1);
}

// ---------- 2. Create team (idempotent: 302 to /settings/teams/<slug>) ----------

async function ensureTeam() {
  // Try creating; if the slug clashes, the form-action redirects with an
  // error param — but on a fresh install we expect a clean redirect.
  const res = await request("POST", "/settings/teams/new", {
    cookies: sessionCookies,
    form: { name: TEAM_NAME },
  });
  if (res.status !== 302) {
    console.error(
      pc.red(
        `team creation returned ${res.status}: ${(await res.text()) || "(empty body)"}`,
      ),
    );
    process.exit(1);
  }
  const location = res.headers.get("location") ?? "";
  const match = location.match(/\/settings\/teams\/([^/?#]+)/);
  if (!match) {
    console.error(
      pc.red(`team creation redirected to unexpected URL: ${location}`),
    );
    process.exit(1);
  }
  const slug = match[1];
  // If slug is suffixed (e.g. "demo-2"), the team probably already
  // exists — but the form action is INSERT-ALWAYS today, so a re-run
  // creates a second team. Check for this and bail with a clear error.
  if (slug !== TEAM_SLUG) {
    console.error(
      pc.red(
        `expected team slug "${TEAM_SLUG}" but got "${slug}" — looks like a duplicate. Delete the existing team or wipe local DO state.`,
      ),
    );
    process.exit(1);
  }
  return slug;
}

log(`${pc.dim("›")} creating team "${TEAM_NAME}"…`);
const teamSlug = await ensureTeam();

// ---------- 3. Create project ----------

async function ensureProject() {
  const res = await request(
    "POST",
    `/settings/teams/${teamSlug}/projects/new`,
    {
      cookies: sessionCookies,
      form: { name: PROJECT_NAME },
    },
  );
  if (res.status !== 302) {
    console.error(
      pc.red(
        `project creation returned ${res.status}: ${(await res.text()) || "(empty body)"}`,
      ),
    );
    process.exit(1);
  }
  // project-new redirects to /settings/teams/<teamSlug> on success and to
  // /settings/teams/<teamSlug>/projects/new?error=… on validation failure.
  // Both are 302s, so we have to read the Location to tell them apart.
  const location = res.headers.get("location") ?? "";
  const expectedSuccessPath = `/settings/teams/${teamSlug}`;
  const locationPath = (() => {
    try {
      return new URL(location, baseUrl).pathname;
    } catch {
      return location;
    }
  })();
  if (locationPath !== expectedSuccessPath) {
    console.error(
      pc.red(`project creation redirected to unexpected URL: ${location}`),
    );
    process.exit(1);
  }
  // Success path doesn't include the project slug, so we trust that
  // PROJECT_NAME slugifies to PROJECT_SLUG (no existing project on this
  // fresh team to force a "-2" suffix).
  return PROJECT_SLUG;
}

log(`${pc.dim("›")} creating project "${PROJECT_NAME}"…`);
const projectSlug = await ensureProject();

// ---------- 4. Mint API key (read plaintext from reveal cookie) ----------

const REVEAL_COOKIE = "wrightful_reveal_key";

log(`${pc.dim("›")} minting API key…`);
const keyRes = await request(
  "POST",
  `/settings/teams/${teamSlug}/p/${projectSlug}/keys`,
  {
    cookies: sessionCookies,
    form: { action: "create", label: "fixtures" },
  },
);
if (keyRes.status !== 302) {
  console.error(
    pc.red(
      `api key creation returned ${keyRes.status}: ${(await keyRes.text()) || "(empty body)"}`,
    ),
  );
  process.exit(1);
}

const setCookies = keyRes.headers.getSetCookie();
const reveal = setCookies
  .map((raw) => {
    const [head, ...attrs] = raw.split(";").map((s) => s.trim());
    const eq = head.indexOf("=");
    if (eq < 0) return null;
    const name = head.slice(0, eq);
    const value = head.slice(eq + 1);
    return { name, value, attrs };
  })
  .filter(Boolean)
  .find((c) => c.name === REVEAL_COOKIE);

if (!reveal || !reveal.value) {
  console.error(
    pc.red(
      "key creation succeeded but reveal cookie was missing — cannot recover the plaintext key.",
    ),
  );
  process.exit(1);
}
const apiKey = decodeURIComponent(reveal.value);

// ---------- 5. Save seed file ----------

writeFileSync(
  seedOutputPath,
  JSON.stringify(
    {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      url: baseUrl,
      teamSlug,
      projectSlug,
      apiKey,
    },
    null,
    2,
  ) + "\n",
);

log("");
log("seeded demo account:");
log(`  email:    ${DEMO_EMAIL}`);
log(`  password: ${DEMO_PASSWORD}`);
log(`  team:     ${teamSlug}`);
log(`  project:  ${projectSlug}`);
log(`  api key:  ${apiKey}`);
log(`  (also written to packages/dashboard/.dev.vars.seed.json)`);
