/**
 * Playwright globalSetup for the dashboard UI suite.
 *
 * 1. Boots the dashboard with a seeded user/team/project/API key (shared
 *    `bootDashboard` helper).
 * 2. Streams a real Playwright dogfood run into the dashboard so the UI has
 *    something to render (otherwise every spec would have to seed its own
 *    data through the API, doubling test time).
 * 3. Logs in via the actual /login form once and saves `storageState.json`
 *    so every spec starts authenticated. Specs that test the unauth path
 *    explicitly clear storage in their own `test.use({ storageState: … })`.
 *
 * The fixture handle is stashed in a module-scoped variable that
 * `global-teardown.ts` reads. `globalThis` because Playwright spawns the
 * teardown in the same Node process.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type FullConfig } from "@playwright/test";

import { bootDashboard, type DashboardFixture } from "../src/dashboard-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = resolve(__dirname, "..");
const STORAGE_STATE_PATH = resolve(__dirname, ".auth", "storageState.json");
const FIXTURE_PATH = resolve(__dirname, ".auth", "fixture.json");

const PORT = 5189;

declare global {
  // eslint-disable-next-line no-var
  var __wrightfulDashboardFixture: DashboardFixture | undefined;
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const fixture = await bootDashboard({
    port: PORT,
    devVarsBackupSuffix: "playwright-dashboard-backup",
  });
  globalThis.__wrightfulDashboardFixture = fixture;

  try {
    console.log(
      "[playwright] Seeding the dashboard with a streamed Playwright run",
    );
    try {
      execSync("npx playwright test --config=playwright.config.ts", {
        cwd: E2E_DIR,
        stdio: "pipe",
        env: {
          ...process.env,
          WRIGHTFUL_URL: fixture.url,
          WRIGHTFUL_TOKEN: fixture.apiKey,
        },
      });
    } catch {
      // The dogfood suite includes intentional failures; we only care that
      // results streamed in. The UI specs will assert the runs page is
      // populated; no need to gate on the dogfood exit code.
    }

    console.log("[playwright] Building storageState from sign-up cookies");
    mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
    if (existsSync(STORAGE_STATE_PATH)) unlinkSync(STORAGE_STATE_PATH);

    // The sign-up step in bootDashboard returned a Set-Cookie header set
    // representing a valid Better Auth session. Inject those cookies into
    // a fresh browser context and write the resulting storageState — that
    // gives every spec a logged-in starting point without round-tripping
    // through the /login form. Specs that test the login form itself
    // explicitly drop storageState in their own `test.use({...})`.
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const cookies = fixture.sessionCookies
      .map((raw) => {
        const eq = raw.indexOf("=");
        if (eq < 0) return null;
        return {
          name: raw.slice(0, eq),
          value: raw.slice(eq + 1),
          domain: "localhost",
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax" as const,
          expires: -1,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    await context.addCookies(cookies);
    await context.storageState({ path: STORAGE_STATE_PATH });
    await browser.close();

    // Stash fixture metadata for teardown + spec consumption (the fixture
    // object itself isn't serialisable — `teardown` is a closure).
    writeFileSync(
      FIXTURE_PATH,
      JSON.stringify(
        {
          url: fixture.url,
          apiKey: fixture.apiKey,
          teamSlug: fixture.teamSlug,
          projectSlug: fixture.projectSlug,
          betterAuthSecret: fixture.betterAuthSecret,
          email: fixture.email,
          password: fixture.password,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    fixture.teardown();
    globalThis.__wrightfulDashboardFixture = undefined;
    throw err;
  }
}
