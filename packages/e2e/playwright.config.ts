import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: [["list"], ["json", { outputFile: "playwright-report.json" }]],
  retries: 1,
  use: {
    baseURL: "https://playwright.dev",
  },
});
