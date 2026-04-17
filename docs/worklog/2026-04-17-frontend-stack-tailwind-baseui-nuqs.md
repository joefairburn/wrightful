# 2026-04-17 — Frontend stack: Tailwind v4 + Base UI/COSS + nuqs

## What changed

Refined the dashboard frontend stack in preparation for building out the UI beyond the current inline-style pages. This is phase 1 of a stack refresh — auth (better-auth) is deferred to a follow-up.

Three pieces:

1. **Tailwind CSS v4** with `tailwind-merge` + `clsx` for class composition.
2. **Base UI** (`@base-ui-components/react`) as the primitive library, with a `components.json` prepared for [COSS](https://coss.com/ui) so individual components can be scaffolded on demand via the shadcn CLI (`npx shadcn@latest add @coss/<name>`). No components scaffolded yet.
3. **nuqs** for type-safe query-string state, wired via the React SPA adapter inside a client-boundary `Providers` component so it works alongside rwsdk's RSC tree.

## New dependencies (`packages/dashboard`)

| Package                     | Version    | Purpose                                              |
| --------------------------- | ---------- | ---------------------------------------------------- |
| `tailwindcss`               | ^4         | Utility-first CSS framework (v4, Lightning CSS)      |
| `@tailwindcss/vite`         | ^4         | Official Vite plugin for Tailwind v4                 |
| `tailwind-merge`            | latest     | Merge conflicting Tailwind classes deterministically |
| `clsx`                      | latest     | Conditional class composition                        |
| `@base-ui-components/react` | 1.0.0-rc.0 | Unstyled accessible primitives used by COSS          |
| `nuqs`                      | latest     | Type-safe URL query-string state                     |

## Files added

- `packages/dashboard/src/app/styles.css` — `@import "tailwindcss";` entry point
- `packages/dashboard/src/app/providers.tsx` — client-boundary (`"use client"`) wrapper that mounts `NuqsAdapter`. Used inside `Document`; NuqsAdapter provides context to any client component in the tree while server components pass through untouched.
- `packages/dashboard/src/lib/cn.ts` — `cn()` helper = `twMerge(clsx(...))`. Used by all future UI primitives.
- `packages/dashboard/components.json` — shadcn CLI config. Aliases: `components → @/app/components`, `ui → @/app/components/ui`, `utils → @/lib/cn`. Lucide icons, neutral base, CSS variables on. When the first COSS component is added (e.g. `npx shadcn@latest add @coss/style` for theme tokens, or `add @coss/button` etc.), files land under `src/app/components/ui/`.
- `packages/dashboard/src/app/components/ui/.gitkeep` — reserves the UI component dir.

## Files changed

### `packages/dashboard/vite.config.mts`

Added `@tailwindcss/vite` plugin and an `environments: { ssr: {} }` stub per rwsdk's Tailwind setup guide (prevents a build issue with the ssr environment when the Tailwind plugin is present).

### `packages/dashboard/src/app/document.tsx`

- Imports `./styles.css?url` and renders `<link rel="stylesheet" href={styles} />` in `<head>` (rwsdk-recommended pattern for Vite-processed CSS).
- Wraps `children` in `<Providers>` so nuqs context is available to any client island below.

## Stack notes / decisions

- **COSS vs manual Base UI**: components are installed on demand via `shadcn@latest add @coss/<name>`. Not running `shadcn init` globally — manual `components.json` + styles.css keeps the setup explicit and avoids interactive CLI state. When the first UI work starts, running `shadcn@latest add @coss/style` will populate coss theme tokens (`--background`, `--foreground`, destructive/info/success/warning families, fonts, etc.) into `styles.css`.
- **nuqs adapter choice**: used `nuqs/adapters/react` (SPA adapter). rwsdk isn't Next.js or React Router, so the generic React adapter is the right one. Caveat: with no known server, the `shallow: false` option is a no-op. RSC pages remain server-rendered; filter/sort UIs should become small client islands that read/write the URL via nuqs.
- **Tailwind v4**: no `tailwind.config.js` needed — theme config goes in `styles.css` via `@theme { ... }` when/if we extend the defaults.
- **Pre-existing dev-env caveat**: visiting `/` locally returns HTTP 500 until `pnpm db:migrate:local` is applied (empty D1 has no `runs` table). This is unrelated to this change and was true on `main`.

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` — pass (tsgo)
- `pnpm --filter @wrightful/dashboard build` — pass; emits `dist/worker/assets/styles-*.css` (4.06 kB Tailwind baseline) and `dist/client/assets/providers-*.js` (4.73 kB, includes NuqsAdapter)
- `pnpm --filter @wrightful/dashboard test` — 43/43 pass (5 files)
- `pnpm lint` — no new warnings (5 pre-existing warnings unchanged)
- Dev server boot + `/src/app/styles.css` served by Vite with Tailwind v4.2.2 output confirmed (base reset + utility layers present)

## Follow-ups

- Scaffold first COSS components (`@coss/style` for theme tokens, then `button`, `table`, `dialog`, etc.) when building real UI.
- Convert inline-styled pages (`runs-list.tsx`, `run-detail.tsx`, `test-detail.tsx`, `test-history.tsx`) to Tailwind + COSS primitives.
- Replace hand-rolled filter/sort state with nuqs once we have real filter UIs.
- Add better-auth (deferred) — pending decision on OAuth provider (leaning GitHub) and relation to existing API-key auth for `/api/*`.
