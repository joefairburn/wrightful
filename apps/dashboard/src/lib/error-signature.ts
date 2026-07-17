import { stripAnsi } from "@/lib/ansi";

/** Error fingerprints stay compact enough to group and return in MCP payloads. */
export const ERROR_SIGNATURE_MAX_CHARS = 240;

/**
 * Statuses whose rows carry a failure worth fingerprinting and co-relating.
 * Hand-listed like `run-diff.ts`'s FAILING_STATUSES: `interrupted` never
 * appears on the per-test wire enum and `queued`/`skipped` carry no error.
 * A `flaky` row DOES carry one — the reporter propagates the failing
 * attempt's error to the final result (see `errorSource` in
 * `packages/reporter/src/index.ts`).
 */
export const FAILURE_STATUSES = ["flaky", "failed", "timedout"] as const;

export function isFailureStatus(status: string): boolean {
  return (FAILURE_STATUSES as readonly string[]).includes(status);
}

/**
 * The persisted-at-ingest failure fingerprint for one final test result:
 * {@link normalizeErrorSignature} over the error message, falling back to the
 * stack when the message is blank — the same message-first/stack-fallback rule
 * the MCP dossier's `errorHead` read used, so switching readers to the stored
 * column changed no signatures. Non-failure statuses fingerprint to `null`
 * (their rows carry no error worth grouping).
 */
export function failureSignature(
  status: string,
  errorMessage: string | null | undefined,
  errorStack: string | null | undefined,
): string | null {
  if (!isFailureStatus(status)) return null;
  const source = errorMessage?.trim() ? errorMessage : errorStack;
  return normalizeErrorSignature(source);
}

const STACK_FRAME_RE = /^at\s+/;
const ERROR_PREFIX_RE = /^(?:error|assertionerror):\s*/i;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s)\]}>,]+/gi;
const PATH_POSITION_RE =
  /(?:file:\/\/)?(?:[A-Za-z]:)?(?:[/\\][^\s:]+)+:\d+:\d+/g;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const HEX_ID_RE = /\b(?:0x)?[0-9a-f]{8,}\b/gi;
const DURATION_RE =
  /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|m|minutes?)\b/gi;
const QUOTED_RE = /(["'`])(?:\\.|(?!\1).)*\1/g;
const NUMBER_RE = /\b\d+(?:\.\d+)?\b/g;

/**
 * Turn a volatile Playwright error into a stable, human-readable grouping key.
 * Only the first meaningful line is used: stack frames and call logs are useful
 * in a dossier, but make poor fingerprints. Values that commonly change from
 * run to run are masked before the result is whitespace-normalized and capped.
 */
export function normalizeErrorSignature(
  error: string | null | undefined,
): string | null {
  if (!error) return null;

  const line = stripAnsi(error)
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !STACK_FRAME_RE.test(part));
  if (!line) return null;

  const normalized = line
    .replace(ERROR_PREFIX_RE, "")
    .replace(URL_RE, "<url>")
    .replace(PATH_POSITION_RE, "<path>:<line>:<col>")
    .replace(UUID_RE, "<id>")
    .replace(ULID_RE, "<id>")
    .replace(HEX_ID_RE, "<id>")
    .replace(DURATION_RE, "<duration>")
    .replace(QUOTED_RE, "<value>")
    .replace(NUMBER_RE, "<n>")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  return normalized.length <= ERROR_SIGNATURE_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, ERROR_SIGNATURE_MAX_CHARS - 1)}…`;
}
