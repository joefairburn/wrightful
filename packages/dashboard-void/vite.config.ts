import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import { voidPlugin } from "void";
import { voidReact } from "@void/react/plugin";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const schemaPath = fileURLToPath(new URL("./db/schema.ts", import.meta.url));
const voidDbStubPath = fileURLToPath(
  new URL("./src/__tests__/helpers/void-db-stub.ts", import.meta.url),
);

// `vp test` sets mode to "test"; under test we skip voidPlugin/voidReact so
// the test runner doesn't try to bootstrap D1 migrations or wrap tests as
// Workers. Tests run in plain Node (vitest default pool) against the same
// alias map as production.
const isTest = process.env.VITEST === "true" || process.argv.includes("test");

export default defineConfig({
  // Pin to 5173 and fail fast. WRIGHTFUL_PUBLIC_URL is hard-coded to :5173
  // in env defaults and used for OAuth callbacks — silent fallback to 5174
  // would break GitHub auth and confuse the seed/setup scripts.
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    // Mirror the tsconfig `@/*` alias at runtime so non-`src/` source roots
    // (`middleware/`, `routes/`, `pages/`, `crons/`, root `auth.ts`) can
    // import shared lib helpers via `@/lib/...`. tsconfig paths are
    // typecheck-only; Vite/Void's module resolver needs the alias here.
    alias: isTest
      ? {
          // Tests run without the void plugin, so the virtual `@schema` and
          // `void/db` modules aren't materialized — alias them to real files
          // (the schema source, and a stub that re-exports drizzle operators
          // and a guarded `db` placeholder).
          "@": srcDir,
          "@schema": schemaPath,
          "void/db": voidDbStubPath,
        }
      : {
          "@": srcDir,
        },
    // Belt-and-braces: voidReact() already sets this, but pin it here so the
    // worker/SSR + client bundles share a single React copy regardless of
    // plugin ordering.
    dedupe: ["react", "react-dom"],
  },
  // JSX transform + React dedupe are provided by `voidReact()` (which wraps
  // `@vitejs/plugin-react`). Do NOT layer a standalone
  // `@rolldown/plugin-babel` with `reactCompilerPreset()` on top — it runs
  // a redundant babel pass over every file and, when combined with void's
  // worker environment, has produced "Invalid hook call" failures during
  // SSR on heavy pages (see worklog 2026-05-23). If we want the React
  // compiler later, integrate it through voidReact's options instead.
  plugins: isTest
    ? [tailwindcss()]
    : [voidPlugin(), voidReact(), tailwindcss()],
  test: {
    environment: "happy-dom",
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
  },
});
