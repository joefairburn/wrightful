import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./vitest.globalSetup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
