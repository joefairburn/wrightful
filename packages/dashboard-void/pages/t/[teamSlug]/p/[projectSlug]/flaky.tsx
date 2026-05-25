import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { FlakyTestRow } from "@/components/flaky-test-row";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Props } from "./flaky.server";

/**
 * Flaky tests page. Ranked list of testIds with at least one flaky result
 * in the selected window; each row expands inline to show the last few
 * failures (commit SHA / branch / error excerpt).
 */
export default function FlakyTestsPage({
  project,
  range,
  branchParam,
  branchAll,
  branchFilter,
  branches,
  rangeDays,
  totalFlakyTests,
  truncated,
  ranked,
  sparkByTest,
  failsByTest,
  pathname,
  ranges,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;
  const rangeHref = (r: string): string => {
    const p = new URLSearchParams();
    p.set("range", r);
    if (branchParam) p.set("branch", branchParam);
    return `${pathname}?${p.toString()}`;
  };

  return (
    <>
      <div className="px-6 py-5 flex flex-col gap-4 border-b border-border shrink-0 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {totalFlakyTests} Flaky Test{totalFlakyTests === 1 ? "" : "s"}
          </h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono">
            Tests exhibiting unstable behavior across recent CI runs
            {truncated ? ` — showing top ${ranked.length}` : ""}.
          </p>
          <div className="mt-2">
            <RunHistoryBranchFilter
              branches={branches}
              defaultValue={branchParam ?? ALL_BRANCHES}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <AnalyticsButtonGroup
            options={ranges as readonly ("7d" | "14d" | "30d")[]}
            value={range}
            hrefFor={rangeHref}
          />
        </div>
      </div>

      {ranked.length === 0 ? (
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex items-center justify-center h-full p-10">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No flaky tests in this window</EmptyTitle>
                <EmptyDescription>
                  Nothing failed on retry in the last {rangeDays} days
                  {branchAll ? "" : ` on ${branchFilter}`}. Try a wider window
                  or a different branch.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <span className="text-xs text-muted-foreground font-mono">
                  {branches.length > 0 && (
                    <>
                      Branches: {branches.slice(0, 3).join(", ")}
                      {branches.length > 3 ? "…" : ""}
                    </>
                  )}
                </span>
              </EmptyContent>
            </Empty>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm">
              <TableRow>
                <TableHead className="w-12 px-4 text-center font-mono text-[11px] uppercase tracking-wider">
                  Rank
                </TableHead>
                <TableHead className="px-4 font-mono text-[11px] uppercase tracking-wider">
                  Test Specification
                </TableHead>
                <TableHead className="w-28 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                  Flakiness
                </TableHead>
                <TableHead className="w-28 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                  Flaky / Total
                </TableHead>
                <TableHead className="w-48 px-4 font-mono text-[11px] uppercase tracking-wider">
                  Recent Trend
                </TableHead>
                <TableHead className="w-10 px-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranked.map((row, i) => {
                const meta = sparkByTest[row.testId];
                const fails = failsByTest[row.testId] ?? [];
                const latest = fails[0];
                const latestHref = latest
                  ? `${base}/runs/${latest.runId}/tests/${latest.testResultId}?attempt=0`
                  : base;
                return (
                  <FlakyTestRow
                    key={row.testId}
                    rank={i + 1}
                    testId={row.testId}
                    title={meta?.title ?? row.testId}
                    file={meta?.file ?? ""}
                    total={row.total}
                    flakyCount={row.flakyCount}
                    pct={row.pct}
                    sparklinePoints={meta?.sparkline ?? []}
                    recentFailures={fails}
                    projectBase={base}
                    historyHref={latestHref}
                  />
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
