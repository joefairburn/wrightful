import { getAuth } from "@/lib/better-auth";

/**
 * Better Auth catch-all handler — mounted at /api/auth/*. Handles every
 * sign-in / sign-out / callback / session route that Better Auth exposes.
 */
export async function authHandler({ request }: { request: Request }) {
  const auth = getAuth();
  return auth.handler(request);
}
