import type { RunProgressEvent, RunProgressTest } from "@/realtime/events";

/** Wire-format aliases re-exported for downstream consumers. */
export type { RunProgressTest, RunProgressEvent };
export type RunProgressTestStatus = RunProgressTest["status"];
export type RunProgressSummary = RunProgressEvent["summary"];

/**
 * Accumulated state derived from a stream of `RunProgressEvent`s plus the
 * SSR-loaded seed. `byId` maps `testResultId → latest row`; `summary` is the
 * most recent aggregate snapshot (or `null` before the first event / seed).
 *
 * The run-detail analogue of `applyProjectFeedEvent` (`project-feed.ts`): a pure
 * reducer the WS run-room hook (`useRunRoom`) folds each event through, kept
 * React-free so the merge rules are unit-testable without a live connection.
 */
export interface RunProgressState {
  byId: Record<string, RunProgressTest>;
  summary: RunProgressSummary | null;
}

export interface UseRunProgressOptions {
  /** SSR-loaded test rows used to seed the accumulator before the first event. */
  initialTests?: readonly RunProgressTest[];
  /** SSR-loaded aggregate so consumers can render counts before the first event. */
  initialSummary?: RunProgressSummary | null;
}

/**
 * Seed the accumulator from SSR-loaded rows. Mirrors the producer-side
 * `buildChangedTests` (ingest.ts) as the consumer half of the same pattern:
 * both turn the wire contract into the rendered test list, and both are pure
 * so they're unit-testable without React or a live WebSocket.
 *
 * Builds `byId` from `initialTests` (last-writer-wins on duplicate ids, so a
 * later row overwrites an earlier one). `summary` defaults to `null` when no
 * `initialSummary` is supplied.
 */
export function seedRunProgressState(
  initialTests?: readonly RunProgressTest[],
  initialSummary?: RunProgressSummary | null,
): RunProgressState {
  const byId: Record<string, RunProgressTest> = {};
  if (initialTests) {
    for (const t of initialTests) byId[t.id] = t;
  }
  return { byId, summary: initialSummary ?? null };
}

/**
 * Apply one live event to the accumulator and return the next state. Pure;
 * never mutates `prev`. Encodes the four merge rules the subscriber relies on:
 *
 *   1. Ignore non-`"progress"` events — return `prev` unchanged.
 *   2. Replace (not merge) `summary` with the event's snapshot.
 *   3. No-op the `byId` clone when `changedTests` is empty (return the same
 *      `byId` reference so referential-equality consumers don't re-render the
 *      list needlessly).
 *   4. Otherwise merge `changedTests` into a cloned `byId` keyed by id
 *      (last-writer-wins, so a retry's later row replaces the earlier one).
 *
 * Note rules 2 and 3 are independent: an empty-`changedTests` progress event
 * still advances `summary` while leaving `byId` referentially stable.
 */
export function applyRunProgressEvent(
  prev: RunProgressState,
  event: RunProgressEvent,
): RunProgressState {
  if (event.type !== "progress") return prev;
  const summary = event.summary;
  if (event.changedTests.length === 0) {
    return { byId: prev.byId, summary };
  }
  const byId = { ...prev.byId };
  for (const t of event.changedTests) {
    byId[t.id] = t;
  }
  return { byId, summary };
}

/**
 * Merge back-paginated rows (older pages fetched from GET /results after
 * mount) into the accumulator. The inverse precedence of
 * `applyRunProgressEvent`: rows already in `byId` WIN, because anything there
 * came from the SSR seed or a later live event — both at least as fresh as a
 * DB page that was cut before the fetch resolved. Returns `prev` unchanged
 * (same reference) when every row is already known, so a redundant page is
 * render-free like an ignored event.
 */
export function mergeBackfilledTests(
  prev: RunProgressState,
  tests: readonly RunProgressTest[],
): RunProgressState {
  let byId: Record<string, RunProgressTest> | null = null;
  for (const t of tests) {
    if (t.id in prev.byId) continue;
    byId ??= { ...prev.byId };
    byId[t.id] = t;
  }
  return byId ? { byId, summary: prev.summary } : prev;
}

/**
 * Pick the summary the header should render right now: the live snapshot once
 * any event (or the seed) has populated `state.summary`, otherwise the SSR
 * `fallback`. Pure so the "live-overrides-SSR, SSR-when-no-event" rule has one
 * unit-tested home shared by every header consumer (tiles, OutcomeBar, tab
 * count) instead of each island re-deriving the `?? fallback` coalesce.
 *
 * `state.summary` is non-null whenever `seedRunProgressState` was given an
 * `initialSummary` (the run-detail page always seeds from `run.*`), so in
 * practice the live value is returned from first paint; the `fallback` covers
 * the contract where a consumer subscribes without seeding.
 */
export function currentSummary(
  state: RunProgressState,
  fallback: RunProgressSummary,
): RunProgressSummary {
  return state.summary ?? fallback;
}
