import type {
  Assertion,
  AssertionComparison,
} from "@/lib/monitors/monitor-schemas";
import type { AssertionResult } from "@/lib/monitors/types";

/**
 * Pure assertion evaluation for `http` (uptime) monitors — NO `void/*` imports,
 * so every source × comparison combination is unit-tested directly. Given a
 * {@link ResponseSnapshot} (what the executor observed) and the monitor's
 * assertions, it returns one {@link AssertionResult} per assertion (the observed
 * `actual`, stringified, + a pass/fail), top-to-bottom in author order. The
 * executor short-circuits availability/threshold around this; here we only judge
 * the user's explicit assertions.
 *
 * `actual` is always stringified for storage/display: a missing value (absent
 * header, JSON path that doesn't resolve) is `null`; a found object/array is its
 * JSON; a primitive is `String(value)`. Numeric comparisons (`GREATER_THAN` /
 * `LESS_THAN`) coerce both sides with `Number`; the rest are string operations.
 */

/** The facts the executor gathered from the response, fed to {@link evaluate}. */
export interface ResponseSnapshot {
  /** HTTP status code. */
  status: number;
  /** Response headers, keys LOWERCASED (so lookup is case-insensitive). */
  headers: Record<string, string>;
  /** Response body as text, already truncated to the byte cap by the executor. */
  bodyText: string;
  /** Total wall-clock of the request, ms. */
  totalMs: number;
}

/** A parsed JSON-path lookup outcome — `found` distinguishes `null` from absent. */
interface JsonPathLookup {
  found: boolean;
  value: unknown;
}

/**
 * Resolve a minimal JSONPath subset against a parsed JSON value:
 *   - `$`            the root
 *   - `.prop`        an object property (also `["prop"]` / `['prop']`)
 *   - `[n]`          an array index
 *   - trailing `.length` on an array or string → its length
 *
 * Filters, wildcards, recursion, and slices are deliberately out of scope (a
 * later add). Returns `{ found: false }` the moment a segment can't resolve, so
 * a missing path is distinguishable from a literal `null`/`0`/`""` value.
 */
export function resolveJsonPath(root: unknown, path: string): JsonPathLookup {
  const trimmed = path.trim();
  // Normalize: strip a leading `$`, turn `[n]` / `["k"]` into `.n` / `.k`.
  const normalized = trimmed
    .replace(/^\$/, "")
    .replace(/\[\s*"([^"]*)"\s*\]/g, ".$1")
    .replace(/\[\s*'([^']*)'\s*\]/g, ".$1")
    .replace(/\[\s*(\d+)\s*\]/g, ".$1");
  const segments = normalized.split(".").filter((s) => s.length > 0);

  let current: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    // Trailing `.length` is a virtual accessor over arrays + strings.
    if (
      seg === "length" &&
      i === segments.length - 1 &&
      (Array.isArray(current) || typeof current === "string")
    ) {
      return { found: true, value: current.length };
    }
    if (current == null) return { found: false, value: undefined };
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(seg)) return { found: false, value: undefined };
      const idx = Number(seg);
      if (idx >= current.length) return { found: false, value: undefined };
      current = current[idx];
      continue;
    }
    if (typeof current === "object") {
      // `current` is a non-null object here (null handled above); narrowing to a
      // record so a string-key read typechecks without an index signature.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded object → record for keyed read
      const obj = current as Record<string, unknown>;
      if (!(seg in obj)) return { found: false, value: undefined };
      current = obj[seg];
      continue;
    }
    // A primitive with path segments still to consume → no match.
    return { found: false, value: undefined };
  }
  return { found: true, value: current };
}

/** Stringify a found value for storage/comparison; objects/arrays → JSON. */
function stringifyValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Objects + arrays (and anything else JSON can produce) → their JSON form.
  return JSON.stringify(value);
}

/** Resolve the observed value for one assertion source → `actual` (or null). */
function readActual(
  assertion: Assertion,
  snapshot: ResponseSnapshot,
): string | null {
  switch (assertion.source) {
    case "STATUS_CODE":
      return String(snapshot.status);
    case "RESPONSE_TIME":
      return String(snapshot.totalMs);
    case "HEADERS": {
      const name = (assertion.property ?? "").toLowerCase();
      return snapshot.headers[name] ?? null;
    }
    case "TEXT_BODY":
      return snapshot.bodyText;
    case "JSON_BODY": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(snapshot.bodyText);
      } catch {
        return null; // body isn't JSON — the path can't resolve
      }
      const lookup = resolveJsonPath(parsed, assertion.property ?? "$");
      return lookup.found ? stringifyValue(lookup.value) : null;
    }
  }
}

/** Apply one comparison to an observed `actual` (null = missing) vs `target`. */
function compare(
  comparison: AssertionComparison,
  actual: string | null,
  target: string,
): boolean {
  switch (comparison) {
    case "IS_EMPTY":
      return actual === null || actual === "";
    case "NOT_EMPTY":
      return actual !== null && actual !== "";
    case "EQUALS":
      return actual !== null && actual === target;
    case "NOT_EQUALS":
      // A missing value is "not equal" to any concrete target.
      return actual !== target;
    case "CONTAINS":
      return actual !== null && actual.includes(target);
    case "NOT_CONTAINS":
      return actual === null || !actual.includes(target);
    case "GREATER_THAN": {
      if (actual === null) return false;
      const a = Number(actual);
      const t = Number(target);
      return Number.isFinite(a) && Number.isFinite(t) && a > t;
    }
    case "LESS_THAN": {
      if (actual === null) return false;
      const a = Number(actual);
      const t = Number(target);
      return Number.isFinite(a) && Number.isFinite(t) && a < t;
    }
  }
}

/**
 * Evaluate every assertion against the response snapshot, in author order.
 * Returns the per-assertion results (with the observed `actual` + pass/fail);
 * the caller decides the overall outcome (availability + thresholds + these).
 */
export function evaluate(
  assertions: readonly Assertion[],
  snapshot: ResponseSnapshot,
): AssertionResult[] {
  return assertions.map((assertion) => {
    const actual = readActual(assertion, snapshot);
    return {
      source: assertion.source,
      property: assertion.property ?? null,
      comparison: assertion.comparison,
      target: assertion.target,
      actual,
      pass: compare(assertion.comparison, actual, assertion.target),
    };
  });
}
