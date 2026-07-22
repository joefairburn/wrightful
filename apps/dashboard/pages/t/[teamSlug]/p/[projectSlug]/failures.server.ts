import { defer, defineHandler, type InferProps } from "void";
import {
  loadSignatureAggregates,
  loadSignatureExamples,
  type SignatureWindowAggregate,
} from "@/lib/analytics/failures";
import {
  normalizeBranchFilter,
  resolveAnalyticsWindow,
} from "@/lib/analytics/params";
import { makeRangeParser } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import { requireTenantContext } from "@/lib/tenant-context";

export type Props = InferProps<typeof loader>;

const TOP_N = 50;

type RangeKey = "7d" | "14d" | "30d";
const RANGES: readonly RangeKey[] = ["7d", "14d", "30d"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "14d");

/** KPI strip numbers for the failures page, computed over the FULL window set
 *  (not just the displayed slice). */
export interface FailureKpis {
  /** Distinct failure fingerprints seen in the window. */
  distinctSignatures: number;
  /** Total failure occurrences (rows) across all window signatures. */
  totalOccurrences: number;
  /** Signatures whose project-wide FIRST occurrence falls inside the window. */
  newSignatures: number;
}

/**
 * Summarize the window's signature aggregates into the KPI strip numbers.
 * Each aggregate carries its project-wide `firstSeenAt` (the correlated min
 * in `loadSignatureAggregates`), so "new" is defined over the whole window,
 * by the same `firstSeenAt >= windowStartSec` rule as the row pills. PURE.
 */
export function summarizeFailureKpis(
  aggregates: readonly SignatureWindowAggregate[],
  windowStartSec: number,
): FailureKpis {
  let totalOccurrences = 0;
  let newSignatures = 0;
  for (const agg of aggregates) {
    totalOccurrences += agg.occurrenceCount;
    if (agg.firstSeenAt >= windowStartSec) newSignatures++;
  }
  return {
    distinctSignatures: aggregates.length,
    totalOccurrences,
    newSignatures,
  };
}

/** One displayed signature cluster — aggregate + example rolled into the
 *  serializable row shape the table renders. */
export interface FailureClusterRow {
  signature: string;
  occurrenceCount: number;
  testCount: number;
  lastSeenAt: number;
  /** Project-wide first CI occurrence (see SignatureWindowAggregate). */
  firstSeenAt: number;
  /** First seen inside the current window → the "New" pill. */
  isNew: boolean;
  /** Newest in-window example — the row's link target and title/file context. */
  example: {
    testResultId: string;
    runId: string;
    title: string;
    file: string;
    status: string;
  } | null;
}

/**
 * Failures page loader — cross-run failure clusters keyed on the
 * ingest-persisted `errorSignature` fingerprint. Two passes behind one
 * grouped `defer()` (the flaky page's shape):
 *  1. Per-signature window aggregate (counts, affected tests, last seen,
 *     project-wide first-seen) — ALL window signatures, most-frequent first;
 *     the KPI strip and the "New" pills both derive from it.
 *  2. Newest in-window example row for the displayed slice (row link target).
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);

  const url = new URL(c.req.url);
  const range = parseRange(url.searchParams.get("range"));
  const { branchParam, branchFilter, branchAll } = normalizeBranchFilter(
    url.searchParams.get("branch"),
  );
  const { windowStartSec, days } = resolveAnalyticsWindow(range);
  const rangeDays = days ?? 0;

  // Cheap index-covered DISTINCT driving the eager toolbar filter (same as
  // the flaky page); the heavy signature passes defer together below.
  const branches = await loadProjectBranches(scope);

  // Deferred loader → the body streams per-variant; must not be stored (see
  // flaky.server.ts for the full cache rationale).
  c.header("Cache-Control", "private, no-store");
  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
    },
    range,
    branchParam,
    branchAll,
    branchFilter,
    branches,
    rangeDays,
    pathname: url.pathname,
    ranges: RANGES,

    failures: defer(async () => {
      const aggregates = await loadSignatureAggregates(scope, {
        windowStartSec,
        branch: branchFilter,
      });
      const shown = aggregates.slice(0, TOP_N);

      const exampleRows = await loadSignatureExamples(
        scope,
        shown.map((a) => a.signature),
        { windowStartSec, branch: branchFilter },
      );
      const exampleBySignature = new Map(
        exampleRows.map((r) => [r.signature, r]),
      );

      const rows: FailureClusterRow[] = shown.map((agg) => {
        const example = exampleBySignature.get(agg.signature);
        return {
          signature: agg.signature,
          occurrenceCount: agg.occurrenceCount,
          testCount: agg.testCount,
          lastSeenAt: agg.lastSeenAt,
          firstSeenAt: agg.firstSeenAt,
          isNew: agg.firstSeenAt >= windowStartSec,
          example: example
            ? {
                testResultId: example.testResultId,
                runId: example.runId,
                title: example.title,
                file: example.file,
                status: example.status,
              }
            : null,
        };
      });

      return {
        totalSignatures: aggregates.length,
        truncated: aggregates.length > shown.length,
        rows,
        kpis: summarizeFailureKpis(aggregates, windowStartSec),
      };
    }),
  };
});
