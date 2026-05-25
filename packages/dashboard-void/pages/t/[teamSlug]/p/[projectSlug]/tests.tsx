import {
  CheckCircle2,
  ChevronRight,
  HelpCircle,
  MinusCircle,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { Link } from "@void/react";
import { AnalyticsButtonGroup } from "@/components/analytics/button-group";
import { RunHistoryBranchFilter } from "@/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/components/run-history-branch-filter.shared";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { STATUS_COLORS } from "@/lib/status";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import type { Props } from "./tests.server";

/**
 * Test catalog page. Every distinct testId observed in the window, with
 * counters, average duration, and a tiny pass/flaky/fail outcome bar.
 */
export default function TestsPage({
  project,
  range,
  branchParam,
  branchFilter,
  branches,
  q,
  rows,
  totalUniqueTests,
  currentPage,
  totalPages,
  fromRow,
  toRow,
  pathname,
  ranges,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  const hrefWith = (overrides: Record<string, string | null>): string => {
    const p = new URLSearchParams();
    p.set("range", range);
    if (branchParam) p.set("branch", branchParam);
    if (q) p.set("q", q);
    if (currentPage > 1) p.set("page", String(currentPage));
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    const qs = p.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const pageHref = (page: number): string =>
    hrefWith({ page: page === 1 ? null : String(page) });

  return (
    <>
      <div className="px-6 py-5 flex flex-col gap-4 border-b border-border shrink-0 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tests</h1>
          <p className="text-xs text-muted-foreground mt-1 font-mono">
            {totalUniqueTests.toLocaleString()} unique test
            {totalUniqueTests === 1 ? "" : "s"} seen across runs
          </p>
          <div className="mt-2">
            <RunHistoryBranchFilter
              branches={branches}
              defaultValue={branchParam ?? ALL_BRANCHES}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form className="relative" method="get">
            <input type="hidden" name="range" value={range} />
            {branchParam ? (
              <input type="hidden" name="branch" value={branchParam} />
            ) : null}
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="Filter path or name..."
              className="w-56 rounded-md border border-border bg-background px-3 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/24"
            />
          </form>
          <AnalyticsButtonGroup
            options={ranges as readonly ("7d" | "14d" | "30d")[]}
            value={range}
            hrefFor={(r) => hrefWith({ range: r, page: null })}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex items-center justify-center h-full p-10">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No tests in this window</EmptyTitle>
                <EmptyDescription>
                  {q
                    ? `No tests match "${q}". Try a wider window or clear the filter.`
                    : `No runs recorded in the last ${range}${
                        branchFilter ? ` on ${branchFilter}` : ""
                      }.`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto min-h-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 px-4 text-center font-mono text-[11px] uppercase tracking-wider">
                    Status
                  </TableHead>
                  <TableHead className="px-4 font-mono text-[11px] uppercase tracking-wider">
                    Test
                  </TableHead>
                  <TableHead className="w-32 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                    Last seen
                  </TableHead>
                  <TableHead className="w-16 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                    Runs
                  </TableHead>
                  <TableHead className="w-40 px-4 font-mono text-[11px] uppercase tracking-wider">
                    Pass / Flaky / Fail
                  </TableHead>
                  <TableHead className="w-24 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                    Avg
                  </TableHead>
                  <TableHead className="w-10 px-2" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const tone = statusTone(row.latestStatus);
                  const href =
                    row.latestRunId && row.latestTestResultId
                      ? `${base}/runs/${row.latestRunId}/tests/${row.latestTestResultId}?attempt=0`
                      : base;
                  return (
                    <TableRow
                      key={row.testId}
                      className="border-b border-border/50"
                    >
                      <TableCell className="px-4 py-3">
                        <div className="flex items-center justify-center">
                          <tone.Icon size={18} color={tone.iconColor} />
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3 max-w-md">
                        <Link
                          href={href}
                          className="block truncate font-mono text-sm text-foreground hover:underline"
                        >
                          {row.title || row.testId}
                        </Link>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                          {row.file}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {formatRelativeTime(row.lastSeen)}
                      </TableCell>
                      <TableCell className="px-4 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {row.n.toLocaleString()}
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <OutcomeBar
                          passed={row.passedCount}
                          flaky={row.flakyCount}
                          failed={row.failCount}
                          skipped={row.skippedCount}
                        />
                      </TableCell>
                      <TableCell className="px-4 py-3 text-right font-mono text-xs tabular-nums text-foreground">
                        {row.avgDurationMs === null
                          ? "—"
                          : formatDuration(Math.round(row.avgDurationMs))}
                      </TableCell>
                      <TableCell className="px-2 py-3 text-center text-muted-foreground">
                        <Link href={href} aria-label="Open latest run">
                          <ChevronRight size={14} />
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {totalPages > 1 && (
            <TablePaginationFooter
              fromRow={fromRow}
              toRow={toRow}
              totalCount={totalUniqueTests}
              currentPage={currentPage}
              totalPages={totalPages}
              itemNoun="test"
              pageHref={pageHref}
            />
          )}
        </>
      )}
    </>
  );
}

interface StatusTone {
  Icon: typeof CheckCircle2;
  iconColor: string;
}

function statusTone(status: string): StatusTone {
  switch (status) {
    case "passed":
      return { Icon: CheckCircle2, iconColor: STATUS_COLORS.passed };
    case "failed":
    case "timedout":
      return { Icon: XCircle, iconColor: STATUS_COLORS.failed };
    case "flaky":
      return { Icon: TriangleAlert, iconColor: STATUS_COLORS.flaky };
    case "skipped":
      return { Icon: MinusCircle, iconColor: STATUS_COLORS.skipped };
    default:
      return {
        Icon: HelpCircle,
        iconColor: "var(--color-muted-foreground)",
      };
  }
}

function OutcomeBar({
  passed,
  flaky,
  failed,
  skipped,
}: {
  passed: number;
  flaky: number;
  failed: number;
  skipped: number;
}): React.ReactElement {
  const total = passed + flaky + failed + skipped;
  if (total === 0) {
    return <div className="font-mono text-[10px] text-muted-foreground">—</div>;
  }
  const segments: { count: number; color: string; label: string }[] = [
    { count: passed, color: STATUS_COLORS.passed, label: "passed" },
    { count: flaky, color: STATUS_COLORS.flaky, label: "flaky" },
    { count: failed, color: STATUS_COLORS.failed, label: "failed" },
    { count: skipped, color: STATUS_COLORS.skipped, label: "skipped" },
  ];
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex h-1.5 w-32 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${passed} passed, ${flaky} flaky, ${failed} failed, ${skipped} skipped`}
      >
        {segments.map((s) =>
          s.count > 0 ? (
            <span
              key={s.label}
              style={{
                width: `${(s.count / total) * 100}%`,
                backgroundColor: s.color,
              }}
            />
          ) : null,
        )}
      </div>
      <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
        <span style={{ color: STATUS_COLORS.passed }}>{passed}</span>
        {" / "}
        <span style={{ color: STATUS_COLORS.flaky }}>{flaky}</span>
        {" / "}
        <span style={{ color: STATUS_COLORS.failed }}>{failed}</span>
      </div>
    </div>
  );
}
