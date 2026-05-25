import { defineHandler } from "void";

/**
 * Root layout loader. Intentionally empty: auth + tenant context come from
 * `middleware/01.context.ts` as `c.var.shared`, consumed by client components
 * via `useShared()`. Keeping this loader around (instead of deleting the file)
 * documents the contract — every page layer can opt into its own loader, and
 * the root layer's job is "nothing, middleware owns shared state."
 */
export const loader = defineHandler(async () => {
  return {};
});
