import { defineConfig } from "vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Pin to 5173 and fail fast if it's taken. WRIGHTFUL_PUBLIC_URL (used by
  // Better Auth for OAuth callbacks) is hardcoded to :5173 in wrangler.jsonc,
  // so a silent fallback to 5174 would break auth and confuse tooling that
  // probes the API (e.g. fixture upload during setup:local).
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
    redwood(),
    tailwindcss(),
  ],
  // Pre-bundle deps reachable only through `"use client"` islands
  // (run-progress.tsx in particular). Without this, Vite's SSR optimizer
  // misses them on the first pass and re-optimizes once SSR reaches the
  // island; the re-optimize invalidates the lucide-react bundle hash
  // mid-startup and the Cloudflare runner-worker crashes with "There is a
  // new version of the pre-bundle for lucide-react.js" before the dev
  // server is reachable. E2E global setup spawns a fresh dev server every
  // run, so cold-start is the only path it exercises. Scoped to both the
  // top-level (client) and `ssr` configs because the failing optimization
  // happens in the SSR pre-bundle dir (`deps_ssr/`).
  optimizeDeps: {
    include: ["rwsdk/use-synced-state/client", "lucide-react"],
  },
  ssr: {
    optimizeDeps: {
      include: ["rwsdk/use-synced-state/client", "lucide-react"],
    },
  },
});
