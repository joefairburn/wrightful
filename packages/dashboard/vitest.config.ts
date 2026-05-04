import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Two-project setup: unit tests on the default Node pool (fast, mocked
// `@/control` / `@/tenant`) and integration tests on `@cloudflare/vitest-
// pool-workers` (real workerd + miniflare, real DO bindings).
//
// Scripts:
//   pnpm test                 — unit only (default, fast)
//   pnpm test:integration     — workers-pool tests only
//   pnpm test:all             — both projects
//
// Vitest 4 pool API: the pool installs itself via a Vite plugin
// (`cloudflareTest`) that sets `pool` + `poolRunner` on the project config.
// The older `test.poolOptions.workers` form was removed in vitest 4.
//
// Both projects rely on rwsdk's lazy-init pattern: each Durable Object
// migrates its schema on first access, so there's no `applyD1Migrations`
// step. Integration test helpers under `src/__integration__/helpers/tenant.ts`
// seed via `getControlDb()` over the `CONTROL` DO RPC binding declared in
// `wrangler.test.jsonc`.
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
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/__integration__/**",
        "src/**/*.d.ts",
        "src/client.tsx",
        "src/worker.tsx",
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/__tests__/**/*.test.{ts,tsx}"],
          exclude: ["src/__tests__/components/**"],
        },
      },
      {
        // Client-side component tests run in jsdom against React's *client*
        // export conditions — not workerd / react-server like the rest of
        // the unit project. Standalone (no extends) so we can fully
        // override the root resolve.conditions, which would otherwise
        // pick the react-server build of React.
        resolve: {
          alias: {
            "@/": new URL("./src/", import.meta.url).pathname,
          },
          conditions: ["browser", "module", "import", "default"],
        },
        test: {
          globals: true,
          name: "components",
          environment: "jsdom",
          include: ["src/__tests__/components/**/*.test.{ts,tsx}"],
          setupFiles: ["src/__tests__/components/setup.ts"],
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
