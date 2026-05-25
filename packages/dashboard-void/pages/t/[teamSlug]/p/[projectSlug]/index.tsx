import { GitBranch, GitCommit, GitPullRequest } from "lucide-react";
import { RunsFilterBar } from "@/components/runs-filter-bar";
import { RunTestsPopover } from "@/components/run-tests-popover";
import { TablePaginationFooter } from "@/components/table-pagination-footer";
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
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { branchUrl, commitUrl, prUrl } from "@/lib/pr-url";
import { toSearchParams } from "@/lib/runs-filters";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";
import type { Props } from "./index.server";

const STATUS_DOT: Record<string, string> = {
  passed: "bg-success shadow-[0_0_6px_var(--color-success)]",
  failed: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
  timedout: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
  flaky: "bg-warning",
  interrupted: "bg-warning",
  skipped: "bg-muted-foreground/30",
  running: "bg-primary animate-pulse shadow-[0_0_6px_var(--color-primary)]",
};

/**
 * Runs list page. Mirrors the rwsdk version: filter bar (status, branch,
 * actor, environment, date range, free-text), paginated table, per-row
 * stretched anchor + side popovers.
 *
 * Live updates for in-flight runs use a smaller scope than the rwsdk
 * version — the runs-list popover doesn't subscribe to per-run progress
 * topics today (those land on the run-detail page). The colored "running"
 * dot animation still indicates the in-progress state from the row's
 * stored status.
 */
export default function RunsListPage({
  project,
  runs,
  totalRuns,
  currentPage,
  totalPages,
  offset,
  filters,
  filtersActive,
  options,
  pathname,
}: Props) {
  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  const fromRow = totalRuns === 0 ? 0 : offset + 1;
  const toRow = offset + runs.length;

  const pageHref = (page: number): string => {
    const qs = toSearchParams({ ...filters, page }).toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  return (
    <>
      <div className="shrink-0 border-b border-border px-6 py-3">
        <div className="mb-2.5 flex items-center gap-2.5">
          <h1 className="text-[19px] font-semibold tracking-tight">Runs</h1>
          <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {totalRuns}
            {filtersActive ? " match" : " total"}
          </span>
          <span className="text-[12.5px] text-muted-foreground">
            <span className="font-mono">{project.slug}</span>
          </span>
        </div>
        <RunsFilterBar filters={filters} options={options} pathname={base} />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {runs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No test runs yet</EmptyTitle>
                <EmptyDescription>
                  Wire the reporter into your playwright.config.ts and set
                  WRIGHTFUL_URL + WRIGHTFUL_TOKEN in CI.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-xs">
                  reporter: [[&apos;@wrightful/reporter&apos;]]
                </code>
              </EmptyContent>
            </Empty>
          </div>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted/30 backdrop-blur-sm">
              <TableRow>
                <TableHead className="w-8 px-4" />
                <TableHead className="px-4 font-mono text-[11px] uppercase tracking-wider">
                  Commit
                </TableHead>
                <TableHead className="w-28 px-4 font-mono text-[11px] uppercase tracking-wider">
                  Env
                </TableHead>
                <TableHead className="w-52 px-4 font-mono text-[11px] uppercase tracking-wider">
                  Tests
                </TableHead>
                <TableHead className="w-24 px-4 font-mono text-[11px] uppercase tracking-wider text-right">
                  Duration
                </TableHead>
                <TableHead className="w-28 px-4 font-mono text-[11px] uppercase tracking-wider text-right">
                  Started
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const href = `${base}/runs/${run.id}`;
                const prHref = prUrl(run.ciProvider, run.repo, run.prNumber);
                const commitHref = commitUrl(
                  run.ciProvider,
                  run.repo,
                  run.commitSha,
                );
                const branchHref = branchUrl(
                  run.ciProvider,
                  run.repo,
                  run.branch,
                );
                return (
                  <TableRow
                    key={run.id}
                    className="relative border-b border-border/50"
                  >
                    <TableCell className="px-4 py-3 text-center">
                      {/* Stretched-link pattern (`after:absolute after:inset-0`)
                       * covers the whole row as a click target. Kept as a plain
                       * `<a>` rather than `@void/react`'s `<Link>` because the
                       * pseudo-element overlay collides with Link's click
                       * interception when nested children (the PR/commit/branch
                       * external links below) sit above the same row. */}
                      <a
                        href={href}
                        className="flex items-center justify-center rounded-sm after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-0"
                      >
                        <span className="sr-only">
                          View run {run.commitMessage ?? run.id.slice(0, 8)}
                        </span>
                        <span
                          className={cn(
                            "inline-block w-2.5 h-2.5 rounded-full",
                            STATUS_DOT[run.status] ?? "bg-muted-foreground/30",
                          )}
                        />
                      </a>
                    </TableCell>

                    <TableCell className="px-4 py-3 max-w-md">
                      <div className="flex flex-col gap-1 min-w-0 font-mono text-xs">
                        <span className="truncate text-foreground">
                          {run.commitMessage ? (
                            run.commitMessage
                          ) : run.actor ? (
                            `@${run.actor}`
                          ) : (
                            <span className="italic text-muted-foreground">
                              No message
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-3 min-w-0 text-muted-foreground">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <GitBranch
                              size={12}
                              strokeWidth={2}
                              className="shrink-0"
                            />
                            {run.branch ? (
                              branchHref ? (
                                <a
                                  href={branchHref}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="relative z-10 truncate hover:underline hover:text-foreground"
                                >
                                  {run.branch}
                                </a>
                              ) : (
                                <span className="truncate">{run.branch}</span>
                              )
                            ) : (
                              <span>—</span>
                            )}
                            {run.prNumber != null && prHref ? (
                              <a
                                href={prHref}
                                target="_blank"
                                rel="noreferrer"
                                className="relative z-10 inline-flex items-center gap-0.5 shrink-0 hover:text-foreground"
                                title={`Open PR #${run.prNumber}`}
                              >
                                <GitPullRequest size={10} strokeWidth={2.5} />#
                                {run.prNumber}
                              </a>
                            ) : run.prNumber != null ? (
                              <span className="inline-flex items-center gap-0.5 shrink-0">
                                <GitPullRequest size={10} strokeWidth={2.5} />#
                                {run.prNumber}
                              </span>
                            ) : null}
                          </span>
                          {run.commitSha ? (
                            <span className="flex items-center gap-1.5 shrink-0">
                              <GitCommit
                                size={12}
                                strokeWidth={2}
                                className="shrink-0"
                              />
                              {commitHref ? (
                                <a
                                  href={commitHref}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="relative z-10 hover:underline hover:text-foreground"
                                  title="View commit"
                                >
                                  {run.commitSha.slice(0, 7)}
                                </a>
                              ) : (
                                <span>{run.commitSha.slice(0, 7)}</span>
                              )}
                              {run.actor && run.commitMessage ? (
                                <span className="shrink-0">· @{run.actor}</span>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </TableCell>

                    <TableCell className="px-4 py-3">
                      {run.environment ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-border bg-muted/40 font-mono text-[11px] text-foreground max-w-[110px] truncate">
                          {run.environment}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>

                    <TableCell className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <RunTestsPopover
                          variant="passed"
                          count={run.passed}
                          teamSlug={project.teamSlug}
                          projectSlug={project.slug}
                          runId={run.id}
                          runHref={href}
                        />
                        <RunTestsPopover
                          variant="failed"
                          count={run.failed}
                          teamSlug={project.teamSlug}
                          projectSlug={project.slug}
                          runId={run.id}
                          runHref={href}
                        />
                        <RunTestsPopover
                          variant="flaky"
                          count={run.flaky}
                          teamSlug={project.teamSlug}
                          projectSlug={project.slug}
                          runId={run.id}
                          runHref={href}
                        />
                        <RunTestsPopover
                          variant="skipped"
                          count={run.skipped}
                          teamSlug={project.teamSlug}
                          projectSlug={project.slug}
                          runId={run.id}
                          runHref={href}
                        />
                      </div>
                    </TableCell>

                    <TableCell className="px-4 py-3 text-right">
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatDuration(run.durationMs)}
                      </span>
                    </TableCell>

                    <TableCell className="px-4 py-3 text-right">
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatRelativeTime(run.createdAt)}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <TablePaginationFooter
        fromRow={fromRow}
        toRow={toRow}
        totalCount={totalRuns}
        currentPage={currentPage}
        totalPages={totalPages}
        itemNoun="run"
        pageHref={pageHref}
        className="bg-background"
      />
    </>
  );
}
