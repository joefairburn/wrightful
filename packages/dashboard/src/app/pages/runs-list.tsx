import { GitBranch, GitCommit, GitPullRequest } from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import {
  RunsFilterBar,
  RunsSearchInput,
} from "@/app/components/runs-filter-bar";
import { RunRowProgressIsland } from "@/app/components/run-progress";
import { RunTestsPopover } from "@/app/components/run-tests-popover";
import {
  composeRunProgress,
  runRoomId,
  type RunProgress,
} from "@/routes/api/progress";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/app/components/ui/empty";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/app/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { NotFoundPage } from "@/app/pages/not-found";
import { getActiveProject } from "@/lib/active-project";
import { cn } from "@/lib/cn";
import { branchUrl, commitUrl, prUrl } from "@/lib/pr-url";
import {
  buildRunsWhere,
  DEFAULT_PAGE_SIZE,
  hasAnyFilter,
  parseRunsFilters,
  toSearchParams,
} from "@/lib/runs-filters";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";

const STATUS_DOT: Record<string, string> = {
  passed: "bg-success shadow-[0_0_6px_var(--color-success)]",
  failed: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
  timedout: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
  flaky: "bg-warning",
  interrupted: "bg-warning",
  skipped: "bg-muted-foreground/30",
  running: "bg-primary animate-pulse shadow-[0_0_6px_var(--color-primary)]",
};

export async function RunsListPage() {
  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const url = new URL(requestInfo.request.url);
  const filters = parseRunsFilters(url.searchParams);
  const filtersActive = hasAnyFilter(filters);

  const totalsRow = await project.db
    .selectFrom("runs")
    .select((eb) => eb.fn.countAll<number>().as("value"))
    .where((eb) => buildRunsWhere(eb, project.id, filters))
    .executeTakeFirst();
  const totalRuns = totalsRow?.value ?? 0;

  const totalPages = Math.max(1, Math.ceil(totalRuns / DEFAULT_PAGE_SIZE));
  const currentPage = Math.min(filters.page, totalPages);
  const offset = (currentPage - 1) * DEFAULT_PAGE_SIZE;

  const [allRuns, branchRows, actorRows, envRows] = await Promise.all([
    project.db
      .selectFrom("runs")
      .selectAll()
      .where((eb) => buildRunsWhere(eb, project.id, filters))
      .orderBy("createdAt", "desc")
      .limit(DEFAULT_PAGE_SIZE)
      .offset(offset)
      .execute(),
    project.db
      .selectFrom("runs")
      .select("branch as value")
      .distinct()
      .where("projectId", "=", project.id)
      .where("committed", "=", 1)
      .where("branch", "is not", null)
      .execute(),
    project.db
      .selectFrom("runs")
      .select("actor as value")
      .distinct()
      .where("projectId", "=", project.id)
      .where("committed", "=", 1)
      .where("actor", "is not", null)
      .execute(),
    project.db
      .selectFrom("runs")
      .select("environment as value")
      .distinct()
      .where("projectId", "=", project.id)
      .where("committed", "=", 1)
      .where("environment", "is not", null)
      .execute(),
  ]);

  const fromRow = totalRuns === 0 ? 0 : offset + 1;
  const toRow = offset + allRuns.length;

  const pageHref = (page: number): string => {
    // Reserialize from the parsed filters so rwsdk-internal params (e.g.
    // `__rsc`) added during an RSC navigation don't leak into subsequent
    // links — preserving `__rsc` turns the next click into a raw-RSC fetch.
    const qs = toSearchParams({ ...filters, page }).toString();
    return qs ? `${url.pathname}?${qs}` : url.pathname;
  };

  const pageWindow = buildPageWindow(currentPage, totalPages);

  const options = {
    branches: branchRows
      .map((r) => r.value)
      .filter((v): v is string => !!v)
      .sort(),
    actors: actorRows
      .map((r) => r.value)
      .filter((v): v is string => !!v)
      .sort(),
    environments: envRows
      .map((r) => r.value)
      .filter((v): v is string => !!v)
      .sort(),
  };

  // Seed RunProgress for each running row so the island has accurate SSR
  // state before its WS connects. Historical runs skip this compose.
  const runningProgress = new Map<string, RunProgress>();
  await Promise.all(
    allRuns
      .filter((r) => r.status === "running")
      .map(async (r) => {
        const p = await composeRunProgress(project, r.id);
        if (p) runningProgress.set(r.id, p);
      }),
  );

  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  return (
    <>
      {/* Page header */}
      <div className="px-6 py-4 flex items-center justify-between border-b border-border shrink-0 gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <h2 className="text-base font-semibold tracking-tight">All Runs</h2>
          <span className="px-2 py-0.5 rounded-sm bg-muted text-muted-foreground font-mono text-xs border border-border/50">
            {totalRuns}
            {filtersActive ? " match" : " total"}
          </span>
        </div>
        <RunsSearchInput filters={filters} pathname={base} />
      </div>

      {/* Filter bar */}
      <div className="px-6 py-3 border-b border-border shrink-0">
        <RunsFilterBar filters={filters} options={options} pathname={base} />
      </div>

      {/* Table area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {allRuns.length === 0 ? (
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
              <TableRow className="border-b border-border hover:bg-transparent dark:hover:bg-transparent">
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
              {allRuns.map((run) => {
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
                    {/* Status dot + stretched row link */}
                    <TableCell className="px-4 py-3 text-center">
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

                    {/* Branch (top) + Commit SHA + message (bottom) */}
                    <TableCell className="px-4 py-3 max-w-md">
                      <div className="flex flex-col gap-1 min-w-0 font-mono text-xs">
                        {/* Branch row */}
                        <span className="flex items-center gap-2 min-w-0 text-foreground">
                          <GitBranch
                            size={12}
                            strokeWidth={2}
                            className="shrink-0 text-muted-foreground"
                          />
                          {run.branch ? (
                            branchHref ? (
                              <a
                                href={branchHref}
                                target="_blank"
                                rel="noreferrer"
                                className="relative z-10 truncate hover:underline"
                              >
                                {run.branch}
                              </a>
                            ) : (
                              <span className="truncate">{run.branch}</span>
                            )
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          {run.prNumber != null && prHref ? (
                            <a
                              href={prHref}
                              target="_blank"
                              rel="noreferrer"
                              className="relative z-10 inline-flex items-center gap-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                              title={`Open PR #${run.prNumber}`}
                            >
                              <GitPullRequest size={10} strokeWidth={2.5} />#
                              {run.prNumber}
                            </a>
                          ) : run.prNumber != null ? (
                            <span className="inline-flex items-center gap-0.5 shrink-0 text-muted-foreground">
                              <GitPullRequest size={10} strokeWidth={2.5} />#
                              {run.prNumber}
                            </span>
                          ) : null}
                        </span>
                        {/* Commit row */}
                        <span className="flex items-center gap-2 min-w-0 text-muted-foreground">
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
                              className="relative z-10 flex items-center gap-2 min-w-0 hover:underline"
                              title="View commit on GitHub"
                            >
                              {run.commitSha ? (
                                <span className="shrink-0">
                                  {run.commitSha.slice(0, 7)}
                                </span>
                              ) : null}
                              <span className="truncate">
                                {run.actor && `@${run.actor} · `}
                                {run.commitMessage ??
                                  (!run.actor && (
                                    <span className="italic">No message</span>
                                  ))}
                              </span>
                            </a>
                          ) : (
                            <>
                              {run.commitSha ? (
                                <span className="shrink-0">
                                  {run.commitSha.slice(0, 7)}
                                </span>
                              ) : null}
                              <span className="truncate">
                                {run.actor && `@${run.actor} · `}
                                {run.commitMessage ??
                                  (!run.actor && (
                                    <span className="italic">No message</span>
                                  ))}
                              </span>
                            </>
                          )}
                        </span>
                      </div>
                    </TableCell>

                    {/* Environment */}
                    <TableCell className="px-4 py-3">
                      {run.environment ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-border bg-muted/40 font-mono text-[11px] text-foreground max-w-[110px] truncate">
                          {run.environment}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>

                    {/* Test counts */}
                    <TableCell className="px-4 py-3">
                      {run.status === "running" &&
                      runningProgress.has(run.id) ? (
                        <RunRowProgressIsland
                          initial={runningProgress.get(run.id)!}
                          roomId={runRoomId({
                            teamSlug: project.teamSlug,
                            projectSlug: project.slug,
                            runId: run.id,
                          })}
                          teamSlug={project.teamSlug}
                          projectSlug={project.slug}
                          runId={run.id}
                          runHref={href}
                        />
                      ) : (
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
                      )}
                    </TableCell>

                    {/* Duration */}
                    <TableCell className="px-4 py-3 text-right">
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatDuration(run.durationMs)}
                      </span>
                    </TableCell>

                    {/* When */}
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

      {/* Footer */}
      <div className="px-6 py-3 border-t border-border flex justify-between items-center gap-4 text-xs text-muted-foreground font-mono bg-background shrink-0">
        <span>
          {totalRuns === 0
            ? "No runs"
            : `Showing ${fromRow}–${toRow} of ${totalRuns} runs`}
        </span>
        {totalPages > 1 && (
          <Pagination className="mx-0 w-auto justify-end">
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href={currentPage > 1 ? pageHref(currentPage - 1) : undefined}
                  aria-disabled={currentPage === 1}
                  className={cn(
                    currentPage === 1 && "pointer-events-none opacity-50",
                  )}
                />
              </PaginationItem>
              {pageWindow.map((entry, i) =>
                entry === "ellipsis" ? (
                  <PaginationItem key={`ellipsis-${i}`}>
                    <PaginationEllipsis />
                  </PaginationItem>
                ) : (
                  <PaginationItem key={entry}>
                    <PaginationLink
                      href={pageHref(entry)}
                      isActive={entry === currentPage}
                    >
                      {entry}
                    </PaginationLink>
                  </PaginationItem>
                ),
              )}
              <PaginationItem>
                <PaginationNext
                  href={
                    currentPage < totalPages
                      ? pageHref(currentPage + 1)
                      : undefined
                  }
                  aria-disabled={currentPage >= totalPages}
                  className={cn(
                    currentPage >= totalPages &&
                      "pointer-events-none opacity-50",
                  )}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        )}
      </div>
    </>
  );
}

function buildPageWindow(
  current: number,
  total: number,
): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages: Array<number | "ellipsis"> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push("ellipsis");
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push("ellipsis");
  pages.push(total);
  return pages;
}
