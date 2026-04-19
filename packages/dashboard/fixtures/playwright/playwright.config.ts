import { defineConfig } from "@playwright/test";

// Dogfoods the streaming reporter. Credentials are injected by
// scripts/upload-fixtures.mjs; when unset, the reporter no-ops and falls
// back to writing wrightful-fallback.json.
export default defineConfig({
  testDir: "./tests",
  retries: 2,
  reporter: [["list"], ["@wrightful/reporter", { artifacts: "all" }]],
  use: {
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
