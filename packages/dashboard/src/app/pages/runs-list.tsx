import { desc, eq } from "drizzle-orm";
import {
  Check,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Minus,
  TriangleAlert,
  X,
} from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import { ProjectShell } from "@/app/components/project-shell";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/app/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { runs } from "@/db/schema";
import { getActiveProject } from "@/lib/active-project";
import { getTeamProjects, getUserTeams } from "@/lib/authz";
import { cn } from "@/lib/cn";
import { prUrl } from "@/lib/pr-url";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";

const STATUS_DOT: Record<string, string> = {
  passed: "bg-success shadow-[0_0_6px_var(--color-success)]",
  failed: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
  timedout: "bg-destructive shadow-[0_0_6px_var(--color-destructive)]",
  flaky: "bg-warning",
  interrupted: "bg-warning",
  skipped: "bg-muted-foreground/30",
};

export async function RunsListPage() {
  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const { ctx } = requestInfo;
  const [teams, projects] = await Promise.all([
    ctx.user ? getUserTeams(ctx.user.id) : Promise.resolve([]),
    getTeamProjects(project.teamId),
  ]);

  const db = getDb();
  const allRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.projectId, project.id))
    .orderBy(desc(runs.createdAt))
    .limit(50);

  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  return (
    <ProjectShell
      teamSlug={project.teamSlug}
      teamName={project.teamName}
      teams={teams}
      projectSlug={project.slug}
      projectName={project.name}
      projects={projects}
      activeNav="runs"
    >
      {/* Page header */}
      <div className="px-6 py-4 flex items-center justify-between border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold tracking-tight">All Runs</h2>
          <span className="px-2 py-0.5 rounded-sm bg-muted text-muted-foreground font-mono text-xs border border-border/50">
            {allRuns.length} total
          </span>
        </div>
      </div>

      {/* Table area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {allRuns.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No test runs yet</EmptyTitle>
                <EmptyDescription>
                  Upload your first Playwright report using the CLI.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-xs">
                  npx @wrightful/cli upload ./playwright-report.json
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
                          <span className="truncate">
                            {run.branch ?? (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </span>
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
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {run.passed > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-success/8 text-success-foreground font-mono text-[11px] dark:bg-success/16">
                            <Check size={10} strokeWidth={3} />
                            {run.passed}
                          </span>
                        )}
                        {run.failed > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-destructive/8 text-destructive-foreground font-mono text-[11px] font-semibold border border-destructive/20 dark:bg-destructive/16">
                            <X size={10} strokeWidth={3} />
                            {run.failed}
                          </span>
                        )}
                        {run.flaky > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-warning/8 text-warning-foreground font-mono text-[11px] border border-warning/20 dark:bg-warning/16">
                            <TriangleAlert size={10} strokeWidth={2.5} />
                            {run.flaky}
                          </span>
                        )}
                        {run.skipped > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground font-mono text-[11px]">
                            <Minus size={10} strokeWidth={2.5} />
                            {run.skipped}
                          </span>
                        )}
                      </div>
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
      <div className="px-6 py-3 border-t border-border flex justify-between items-center text-xs text-muted-foreground font-mono bg-background shrink-0">
        <span>
          Showing {allRuns.length} of {allRuns.length} runs
        </span>
      </div>
    </ProjectShell>
  );
}
