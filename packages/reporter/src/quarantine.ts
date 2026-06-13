// Flaky-test quarantine: fetch the project's quarantine list at onBegin and
// demote a quarantined hard failure to `skipped` on the wire.
//
// v1 enforcement is "demote on the wire": a Playwright reporter is observe-only
// — it sees results after the test has already run, so it cannot `test.skip()`
// execution. The closest it can do is REPORT a quarantined failure as a skip
// (plus a `quarantined` annotation) so a known-flaky test under stabilisation
// doesn't redden the run / fail CI. True skip-execution is a follow-up via a
// `test.extend` fixture that consumes the same list.

import type { StreamClient } from "./client.js";
import type { QuarantineEntry, TestResultPayload } from "./types.js";

/** Map of `testId → quarantine entry` for O(1) lookup during demotion. */
export type QuarantineMap = Map<string, QuarantineEntry>;

/**
 * Fetch the quarantine list and index it by `testId`. Best-effort: the client
 * already swallows every error to an empty list, so this never throws — a
 * fetch failure simply yields an empty map and quarantine becomes a no-op.
 */
export async function fetchQuarantine(
  client: StreamClient,
): Promise<QuarantineMap> {
  const entries = await client.fetchQuarantine();
  return new Map(entries.map((e) => [e.testId, e]));
}

/**
 * Outcomes a quarantine demotes. A quarantined test that *failed* (or timed
 * out, or was flaky — all of which redden the run / fail CI) is reported as
 * `skipped`; a `passed`/`skipped` outcome is left alone (nothing to suppress).
 */
function isDemotableStatus(status: TestResultPayload["status"]): boolean {
  return status === "failed" || status === "timedout" || status === "flaky";
}

/**
 * Pure demotion: given a built result payload and the quarantine map, return
 * the payload to actually report.
 *
 *   - Not quarantined, OR quarantined but passed/skipped → returned UNCHANGED
 *     (same object reference, so a non-quarantined run pays nothing).
 *   - Quarantined AND a demotable failure → a NEW payload with `status` forced
 *     to `"skipped"` and a `{ type: "quarantined", description }` annotation
 *     appended (the original failure detail — message/stack/attempts — is
 *     preserved so the dashboard can still show why it was failing).
 *
 * Kept pure (no client, no I/O) so it's unit-testable in isolation.
 */
export function applyQuarantine(
  payload: TestResultPayload,
  quarantine: QuarantineMap,
): TestResultPayload {
  const entry = quarantine.get(payload.testId);
  if (!entry) return payload;
  if (!isDemotableStatus(payload.status)) return payload;

  return {
    ...payload,
    status: "skipped",
    annotations: [
      ...payload.annotations,
      {
        type: "quarantined",
        description: entry.reason ?? "quarantined",
      },
    ],
  };
}
