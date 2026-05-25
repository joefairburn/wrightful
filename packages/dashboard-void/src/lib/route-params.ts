import { useParams } from "@void/react";

/**
 * Read a string route parameter from the current request. Use inside a page
 * component or layout — Void's `useParams()` returns the URL params for the
 * matching route. For server-side reads from a `.server.ts` loader, use
 * `c.req.param(key)` instead.
 */
export function useParam(key: string): string {
  const params = useParams();
  const v = params[key];
  if (v === undefined) {
    throw new Error(`useParam(): missing route parameter :${key}`);
  }
  return v;
}
