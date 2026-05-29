import type { Context } from "hono";
import type { ResolvedActiveProject } from "@/lib/authz";

/**
 * Reads `activeProject` from the request context. Returns null when not
 * available; callers that strictly require a project should call
 * `requireActiveProject(c)` instead.
 *
 * Populated by `middleware/01.context.ts` for `/t/:teamSlug/p/:projectSlug/...`
 * requests with a valid session and confirmed membership.
 */
export function getActiveProject(c: Context): ResolvedActiveProject | null {
  return c.get("activeProject") ?? null;
}

export function requireActiveProject(c: Context): ResolvedActiveProject {
  const ap = c.get("activeProject");
  if (!ap) {
    throw new Response("Not Found", { status: 404 });
  }
  return ap;
}
