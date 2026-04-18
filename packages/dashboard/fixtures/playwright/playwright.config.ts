import { defineConfig } from "@playwright/test";

const reportPath = process.env.WRIGHTFUL_FIXTURE_REPORT ?? "report.json";

export default defineConfig({
  testDir: "./tests",
  retries: 2,
  reporter: [["list"], ["json", { outputFile: reportPath }]],
  use: {
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
