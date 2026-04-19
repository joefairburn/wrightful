import { defineConfig } from "@playwright/test";

// Streaming reporter is always configured; it no-ops if WRIGHTFUL_URL /
// WRIGHTFUL_TOKEN aren't in the environment, so local runs stay quiet while
// CI runs dogfood the full streaming path.
export default defineConfig({
  testDir: "./tests",
  reporter: [
    ["list"],
    ["json", { outputFile: "playwright-report.json" }],
    ["@wrightful/reporter"],
  ],
  retries: 1,
  use: {
    baseURL: "https://playwright.dev",
  },
});
