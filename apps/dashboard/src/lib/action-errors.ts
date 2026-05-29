import { logger } from "void/log";

/**
 * Map a thrown mutation error to a user-facing flash message.
 *
 * A UNIQUE-constraint violation is an *expected* user error (duplicate
 * slug/name) — return the supplied friendly message WITHOUT logging.
 * Anything else is *unexpected* (D1 unavailable, batch failure, a bug) — log
 * it to Cloudflare Tail with the given context before returning a generic
 * message, so production mutation failures are never silently swallowed.
 *
 * Replaces the copy-pasted `msg.includes("UNIQUE") ? … : …` blocks in the
 * settings create/update actions, which discarded the original error.
 */
export function mutationErrorMessage(
  err: unknown,
  opts: { context: string; uniqueMessage: string; genericMessage: string },
): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("UNIQUE")) return opts.uniqueMessage;
  logger.error(opts.context, {
    message: msg,
    stack: err instanceof Error ? err.stack : undefined,
  });
  return opts.genericMessage;
}
