import { defineHandler, type InferProps } from "void";

export type Props = InferProps<typeof loader>;

/**
 * Fallback "something went wrong" page. The error middleware
 * (`middleware/00.errors.ts`) rewrites here after catching an uncaught
 * exception. Also reachable directly so the design can be previewed in dev.
 */
export const loader = defineHandler((c) => {
  c.status(500);
  return {};
});
