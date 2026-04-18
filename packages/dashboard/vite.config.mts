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
  environments: {
    ssr: {},
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
    redwood(),
    tailwindcss(),
  ],
});
