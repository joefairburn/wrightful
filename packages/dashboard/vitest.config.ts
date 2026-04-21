import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

// Read control-DB migrations at Node-layer startup so they can be injected
// into the miniflare pool as a `TEST_MIGRATIONS` binding. Integration tests
// apply them via `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`.
const controlMigrations = await readD1Migrations("./migrations");

// Two-project setup: unit tests on the default Node pool (fast, mocked
// `@/db` / `@/tenant`) and integration tests on `@cloudflare/vitest-pool-
// workers` (real workerd + miniflare, real DO + D1 bindings).
//
// Scripts:
//   pnpm test                 — unit only (default, fast)
//   pnpm test:integration     — workers-pool tests only
//   pnpm test:all             — both projects
//
// Vitest 4 pool API: the pool installs itself via a Vite plugin
// (`cloudflareTest`) that sets `pool` + `poolRunner` on the project config.
// The older `test.poolOptions.workers` form was removed in vitest 4.
export default defineConfig({
  // rwsdk ships worker-entry modules behind `react-server` + `workerd`
  // export conditions. Vite applies root `resolve.conditions` during
  // dep pre-bundle; the integration project inherits them. The unit
  // project mocks `rwsdk/*` so the extra conditions are inert there.
  resolve: {
    conditions: ["workerd", "react-server"],
  },
  test: {
    globals: true,
    exclude: ["**/node_modules/**", "**/dist/**", "fixtures/**"],
    alias: {
      "@/": new URL("./src/", import.meta.url).pathname,
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/__tests__/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest({
            // Minimal test entrypoint that exports only the DO classes we
            // bind. Avoids pulling in the full rwsdk router (which needs
            // dev-server-level resolve plumbing to load cleanly).
            main: "./src/__integration__/entrypoint.ts",
            wrangler: {
              configPath: "./wrangler.test.jsonc",
            },
            miniflare: {
              // Surfaces the control-DB migrations as a binding so tests
              // can `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` on
              // a fresh per-suite miniflare instance.
              bindings: {
                TEST_MIGRATIONS: controlMigrations,
              },
            },
          }),
        ],
        test: {
          name: "integration",
          include: ["src/__integration__/**/*.test.ts"],
        },
      },
    ],
  },
});
