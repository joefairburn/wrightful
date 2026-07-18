import { use } from "react";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { DeferredSection } from "@/components/defer-error-boundary";
import { KpiInline } from "@/components/kpi-inline";
import { NewFailurePill } from "@/components/new-failure-pill";
import { PageHeader } from "@/components/page-header";
import { PageToolbar } from "@/components/page-toolbar";
import { RowLink } from "@/components/row-link";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import {
  KpiInlineSkeleton,
  TablePaginationFooterSkeleton,
} from "@/components/skeletons";
import { StatusGlyph } from "@/components/status-glyph";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { PREFETCH_STABLE } from "@/components/ui/link";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { makeHrefBuilder } from "@/lib/page-links";
import { formatRelativeTime } from "@/lib/time-format";
import type { FailureClusterRow, Props } from "./failures.server";

// Skeleton row count while the table streams — same rationale as the flaky
// page: the real count isn't known until the aggregate resolves, and the
// table is the terminal region so it resizes in place.
const SKELETON_ROWS = 8;

/**
 * Failures page — cross-run failure clusters. Every distinct normalized error
 * fingerprint (`errorSignature`) seen in the window, with occurrence counts,
 * affected tests, and first/last seen; fingerprints first appearing in the
 * window carry a "New" pill. Same streaming shape as the flaky page: header +
 * filters paint eagerly, KPI strip and table stream behind one grouped
 * `defer()`.
 */
export default function FailuresPage({
  project,
  range,
  branchParam,
  branchAll,
  branchFilter,
  branches,
  rangeDays,
  failures,
  pathname,
  ranges,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const { with: hrefWith } = makeHrefBuilder(pathname, {
    range,
    branch: branchParam,
  });
  const rangeHref = (r: string): string => hrefWith({ range: r });

  // A deferred region that fails latches its error boundary; clear it when the
  // filters change so the SPA-nav re-fetch re-attempts the region.
  const resetKey = `${range}:${branchParam ?? ""}`;

  return (
    <>
      <PageHeader title="Failures" />

      <PageToolbar>
        <DeferredSection
          errorFallback={<></>}
          resetKey={resetKey}
          skeleton={<KpiInlineSkeleton widths={["w-8", "w-8", "w-12"]} />}
        >
          <FailureKpiStrip failures={failures} />
        </DeferredSection>
        <div className="flex-1" />
        <RunHistoryBranchFilter
          branches={branches}
          defaultValue={branchParam ?? ALL_BRANCHES}
        />
        <AnalyticsButtonGroup
          hrefFor={rangeHref}
          options={ranges as readonly ("7d" | "14d" | "30d")[]}
          value={range}
        />
      </PageToolbar>

      <DeferredSection
        resetKey={resetKey}
        skeleton={<FailuresTableSkeleton rangeDays={rangeDays} />}
      >
        <FailuresTableRegion
          base={base}
          branchAll={branchAll}
          branchFilter={branchFilter}
          failures={failures}
          rangeDays={rangeDays}
        />
      </DeferredSection>
    </>
  );
}

/** Toolbar KPI stats — distinct fingerprints / new this window / total
 *  occurrences, all from the deferred aggregate. */
function FailureKpiStrip({ failures }: { failures: Props["failures"] }) {
  const { kpis } = use(failures);
  return (
    <>
      <KpiInline label="Failure patterns" value={kpis.distinctSignatures} />
      <KpiInline
        accent="var(--fail)"
        label="New this window"
        value={kpis.newSignatures}
      />
      <KpiInline label="Total failures" value={kpis.totalOccurrences} />
    </>
  );
}

/** The clusters table — Empty state or the signature rows + footer. */
function FailuresTableRegion({
  failures,
  base,
  rangeDays,
  branchAll,
  branchFilter,
}: {
  failures: Props["failures"];
  base: string;
  rangeDays: number;
  branchAll: boolean;
  branchFilter: string | null;
}) {
  const { totalSignatures, rows } = use(failures);

  if (rows.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="flex items-center justify-center h-full p-10">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No failures in this window</EmptyTitle>
              <EmptyDescription>
                No test recorded a failure in the last {rangeDays} days
                {branchAll ? "" : ` on ${branchFilter}`}. Try a wider window or
                a different branch.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <span className="text-xs text-fg-3 font-mono">
                Failures cluster by normalized error message, so the same
                breakage across tests and runs shows as one row.
              </span>
            </EmptyContent>
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto min-h-0">
        <Table className="table-fixed" stickyHeader>
          <FailuresTableHead rangeDays={rangeDays} />
          <TableBody>
            {rows.map((row) => (
              <FailureClusterTableRow
                base={base}
                key={row.signature}
                row={row}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      <TablePaginationFooter
        fromRow={1}
        itemNoun="failure pattern"
        toRow={rows.length}
        totalCount={totalSignatures}
      />
    </>
  );
}

/** One signature cluster row: glyph link, fingerprint + example context,
 *  occurrence/test counts, first/last seen. Row click lands on the newest
 *  in-window example's test-detail page. */
function FailureClusterTableRow({
  row,
  base,
}: {
  row: FailureClusterRow;
  base: string;
}) {
  const rowHref = row.example
    ? `${base}/runs/${row.example.runId}/tests/${row.example.testResultId}?attempt=0`
    : base;
  return (
    <TableRow>
      <TableCell className="w-10 px-4 align-middle">
        <RowLink cacheFor={PREFETCH_STABLE} href={rowHref}>
          <span className="sr-only">View {row.signature}</span>
          <StatusGlyph size={14} status={row.example?.status ?? "failed"} />
        </RowLink>
      </TableCell>
      <TableCell className="px-4 py-3 align-middle">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="min-w-0 truncate font-mono text-body text-fg-1"
              title={row.signature}
            >
              {row.signature}
            </span>
            {row.isNew ? <NewFailurePill /> : null}
          </div>
          {row.example ? (
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-micro text-fg-3">
              <span className="min-w-0 truncate" title={row.example.title}>
                {row.example.title}
              </span>
              {row.testCount > 1 ? (
                <span className="shrink-0">
                  +{row.testCount - 1} more test{row.testCount > 2 ? "s" : ""}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="w-[110px] px-4 py-3 text-right align-middle">
        <span className="font-mono text-body font-semibold tabular-nums text-fg-1">
          {row.occurrenceCount}
        </span>
      </TableCell>
      <TableCell className="w-[90px] px-4 py-3 text-right align-middle font-mono text-caption tabular-nums text-fg-3">
        {row.testCount}
      </TableCell>
      <TableCell className="w-[110px] px-4 py-3 text-right align-middle text-caption text-fg-3">
        {formatRelativeTime(row.firstSeenAt)}
      </TableCell>
      <TableCell className="w-[110px] px-4 py-3 text-right align-middle text-caption text-fg-3">
        {formatRelativeTime(row.lastSeenAt)}
      </TableCell>
    </TableRow>
  );
}

/** Shared table header used by both the live table and its skeleton so the
 *  column widths can't drift between states. */
function FailuresTableHead({ rangeDays }: { rangeDays: number }) {
  return (
    <TableHeader className="sticky top-0 z-20 bg-bg-0/95 backdrop-blur-sm">
      <TableRow>
        <TableHead className="w-10 px-4" />
        <TableHead className="px-4">Error</TableHead>
        <TableHead className="w-[110px] px-4 text-right">
          {rangeDays}d failures
        </TableHead>
        <TableHead className="w-[90px] px-4 text-right">Tests</TableHead>
        <TableHead className="w-[110px] px-4 text-right">First seen</TableHead>
        <TableHead className="w-[110px] px-4 text-right">Last seen</TableHead>
      </TableRow>
    </TableHeader>
  );
}

/** Fallback matching the failures table shape — terminal region, so a
 *  differing resolved row count resizes in place. */
function FailuresTableSkeleton({ rangeDays }: { rangeDays: number }) {
  return (
    <>
      <div className="flex-1 overflow-y-auto min-h-0">
        <Table className="table-fixed" stickyHeader>
          <FailuresTableHead rangeDays={rangeDays} />
          <TableBody>
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <TableRow key={i}>
                <TableCell className="w-10 px-4 align-middle">
                  <Skeleton className="mx-auto h-3.5 w-3.5 rounded-full" />
                </TableCell>
                <TableCell className="px-4 py-3 align-middle">
                  <div className="min-w-0">
                    <Skeleton className="h-[13px] w-3/4" />
                    <Skeleton className="mt-0.5 h-[11px] w-1/2" />
                  </div>
                </TableCell>
                <TableCell className="w-[110px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-[13px] w-8" />
                </TableCell>
                <TableCell className="w-[90px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-3 w-6" />
                </TableCell>
                <TableCell className="w-[110px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-3 w-12" />
                </TableCell>
                <TableCell className="w-[110px] px-4 py-3 align-middle">
                  <Skeleton className="ml-auto h-3 w-12" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <TablePaginationFooterSkeleton />
    </>
  );
}
