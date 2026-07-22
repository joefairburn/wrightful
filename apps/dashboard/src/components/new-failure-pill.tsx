import type React from "react";
import { StatusPill } from "@/components/status-pill";

/**
 * "New" badge for a failure fingerprint's FIRST CI appearance — one pill for
 * both surfaces that show it: the run page's Tests tab (`isNewFailure` on
 * `RunProgressTest`) and the Failures page's cluster rows
 * (`FailureClusterRow.isNew`). Both flags derive from the same first-seen
 * rule (`src/lib/analytics/failures.ts` / `src/lib/failure-novelty.ts`), so
 * the badge that announces it is defined once too.
 */
export function NewFailurePill(): React.ReactElement {
  return (
    <StatusPill className="shrink-0" cssVar="--fail" label="New" size="sm" />
  );
}
