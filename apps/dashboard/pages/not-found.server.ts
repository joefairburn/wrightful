import { defineHandler, type InferProps } from "void";

export type Props = InferProps<typeof loader>;

/**
 * Styled 404 page. Reached two ways:
 *   1. Edge fallback — `routing.fallbacks` in `void.json` rewrites any
 *      unmatched URL here (after asset + route lookup have both missed).
 *   2. Internal rewrite — `middleware/00.errors.ts` rewrites here after a
 *      downstream loader throws `Response(404)` or returns a 404 status.
 *
 * Not a catch-all page (`pages/[...slug].tsx`) on purpose: a catch-all
 * pattern matches every URL in the Hono router, which steals Vite's dev
 * source-file URLs (`/pages/.../index.tsx`) and breaks HMR.
 */
export const loader = defineHandler((c) => {
  c.status(404);
  return {};
});
