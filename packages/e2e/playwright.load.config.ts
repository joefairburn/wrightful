import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-load",
  reporter: [["list"], ["@wrightful/reporter"]],
  retries: 0,
  workers: Number(process.env.LOAD_TEST_WORKERS ?? "16"),
  fullyParallel: true,
});
