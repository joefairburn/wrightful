import { defineMiddleware } from "void";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "void/log";

/**
 * Global error gate. Surfaces unhandled exceptions, thrown Responses, and
 * downstream 4xx/5xx as styled HTML pages instead of plain "Internal Server
 * Error" / "Not Found" / "Unauthorized" text.
 *
 * Hono's `compose` catches anything `instanceof Error` (including
 * `HTTPException`, which `void/auth`'s `requireAuth` throws) and converts
 * it to a `Response` via the framework's default error handler before
 * unwinding `next()`. A plain `throw new Response(...)` is NOT an Error,
 * so it propagates back out of `next()` like a normal exception. To cover
 * both, this middleware combines:
 *   1. a try/catch around `next()` for thrown Responses, and
 *   2. an after-the-fact inspection of `c.res.status` for HTTPException-
 *      derived responses Hono already swallowed.
 *
 * Behavior:
 *   - `/api/*`              → never rewrites; reporters + trace viewer keep
 *                             machine-readable JSON/text.
 *   - HTML requests:
 *       - 401               → redirect to /login.
 *       - 404               → rewrite to the catch-all 404 page.
 *       - 5xx / uncaught    → log + rewrite to /oops.
 *   - Already on /oops or /not-found → pass through to avoid loops.
 *
 * Must be the first middleware (`00.`) so the try/catch and the
 * post-next() inspection both bracket `01.context.ts`, `02.api-auth.ts`,
 * and every downstream loader.
 */
const API_PATH_RE = /^\/api\//;
const OOPS_PATH = "/oops";
const NOT_FOUND_PATH = "/not-found";
// Last path segment looks like a filename (`foo.ext`). Matches the same
// heuristic void uses internally in `__voidShouldMarkNoMatch`: these URLs
// are served by Vite dev / the static asset layer, not by us. Without the
// guard, every dev source-file fetch (`/pages/.../layout.tsx`, CSS, etc.)
// 404s in the Hono router, hits our post-next() check, and rewrites to
// /not-found — workerd then warns about the Unicode arrow in void's
// `X-Void-Routing` debug trace header on every navigation.
const FILE_EXT_RE = /\/[^/]+\.[^/]+$/;

export default defineMiddleware(async (c, next) => {
  const path = c.req.path;
  const isApi = API_PATH_RE.test(path);
  const alreadyErrorPage = path === OOPS_PATH || path === NOT_FOUND_PATH;

  try {
    await next();
  } catch (err) {
    if (isApi || alreadyErrorPage) throw err;

    const status = extractStatus(err);
    if (status === 401) return c.redirect("/login");
    if (status === 404) return c.rewrite(NOT_FOUND_PATH);

    logger.error("unhandled error in request pipeline", {
      path,
      status: status ?? 500,
      message: err instanceof Error ? err.message : String(err),
    });
    return c.rewrite(OOPS_PATH);
  }

  if (isApi || alreadyErrorPage || FILE_EXT_RE.test(path)) return;

  // HTTPException paths land here: `await next()` returned normally, but
  // Hono's default errorHandler turned the exception into a Response and
  // stashed it on `c.res` / `c.error`. We cannot just call `c.redirect()`
  // or `c.rewrite()` here — the existing `c.res` carries content-length /
  // content-type from the swallowed error body, and Hono's `c.res` setter
  // merges old headers into whatever we assign next, which corrupts our
  // replacement. The fix is to clear `c.res` first (`= undefined` bypasses
  // the merge branch) and then assign the fresh response.
  const responseStatus = c.res?.status;
  if (responseStatus === 401) {
    replaceResponse(
      c,
      new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      }),
    );
    return;
  }
  if (responseStatus === 404) {
    const rewritten = await c.rewrite(NOT_FOUND_PATH);
    replaceResponse(c, rewritten);
    return;
  }
  if (responseStatus !== undefined && responseStatus >= 500) {
    logger.error("downstream 5xx response", {
      path,
      status: responseStatus,
      message: c.error instanceof Error ? c.error.message : undefined,
    });
    const rewritten = await c.rewrite(OOPS_PATH);
    replaceResponse(c, rewritten);
    return;
  }
});

function extractStatus(err: unknown): number | null {
  if (err instanceof Response) return err.status;
  if (err instanceof HTTPException) return err.status;
  return null;
}

function replaceResponse(c: Context, response: Response): void {
  c.res = undefined;
  c.res = response;
}
