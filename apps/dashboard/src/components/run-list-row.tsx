import { GitBranch, GitPullRequest } from "lucide-react";
import { Link } from "@void/react";
import type React from "react";
import { ActorAvatar } from "@/components/actor-avatar";
import { LiveDuration } from "@/components/live-duration";
import { OutcomeBar } from "@/components/outcome-bar";
import { RunTestsPopover } from "@/components/run-tests-popover";
import { StatusGlyph } from "@/components/status-glyph";
import { TableCell, TableRow } from "@/components/ui/table";
import type { RunListRowData } from "@/realtime/events";
import { branchUrl, commitUrl, prUrl } from "@/lib/pr-url";
import { formatRelativeTime } from "@/lib/time-format";

interface RunListRowProps {
  /**
   * Row data: a `runs` table row (the loader passes the whole row, which
   * satisfies {@link RunListRowData}) with any live room summary already
   * overlaid by the page via `useProjectRoom`.
   */
  run: RunListRowData;
  teamSlug: string;
  projectSlug: string;
  /** Display ordinal (#N), computed by the page from the row's list position. */
  runNum: number;
}

/**
 * One run row on the project runs list. Presentational — every value comes
 * from `run`, so the same markup serves both terminal runs (straight from SSR)
 * and live ones (the page overlays the streamed summary onto `run`). Extracted
 * out of the page so the row markup has a single home.
 */
export function RunListRow({
  run,
  teamSlug,
  projectSlug,
  runNum,
}: RunListRowProps): React.ReactElement {
  const base = `/t/${teamSlug}/p/${projectSlug}`;
  const href = `${base}/runs/${run.id}`;
  const prHref = prUrl(run.ciProvider, run.repo, run.prNumber);
  const commitHref = commitUrl(run.ciProvider, run.repo, run.commitSha);
  const branchHref = branchUrl(run.ciProvider, run.repo, run.branch);
  const total = run.passed + run.failed + run.flaky + run.skipped;

  return (
    <TableRow>
      <TableCell className="w-10 px-4 py-3 align-middle">
        {/* Stretched-link pattern: the `<Link>` is `position: static` so its
         * `after:inset-0` pseudo fills the nearest positioned ancestor — the
         * TableRow (which has `relative` above). Result: the whole row is the
         * click target. Nested `relative z-10` external links (branch/PR/commit
         * chips) call `e.stopPropagation()` so their clicks don't bubble to this
         * Link's SPA-navigation handler. */}
        <Link
          className="flex items-center justify-center focus-visible:outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring"
          href={href}
        >
          <span className="sr-only">
            View run {run.commitMessage ?? run.id.slice(0, 8)}
          </span>
          <StatusGlyph size={14} status={run.status} />
        </Link>
      </TableCell>

      <TableCell className="px-4 py-3 align-middle">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-muted-foreground">
              #{runNum}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-[13.5px] text-foreground"
              title={run.commitMessage ?? undefined}
            >
              {run.commitMessage ? (
                run.commitMessage
              ) : run.actor ? (
                `@${run.actor}`
              ) : (
                <span className="italic text-muted-foreground">No message</span>
              )}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
            {run.branch ? (
              <BranchPill href={branchHref} name={run.branch} />
            ) : null}
            {run.prNumber != null ? (
              <PrPill href={prHref} num={run.prNumber} />
            ) : null}
            {run.environment ? <EnvPill env={run.environment} /> : null}
            {run.commitSha ? (
              <CommitPill href={commitHref} sha={run.commitSha} />
            ) : null}
            {run.actor ? (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <ActorAvatar actor={run.actor} />
                <span className="truncate">{run.actor}</span>
              </span>
            ) : null}
          </div>
        </div>
      </TableCell>

      <TableCell className="w-[220px] px-4 py-3 align-middle">
        <div className="flex flex-col gap-1.5">
          <OutcomeBar
            failed={run.failed}
            flaky={run.flaky}
            height={7}
            passed={run.passed}
            skipped={run.skipped}
            total={total}
          />
          <div className="flex items-center gap-2.5 font-mono text-[11px] tabular-nums">
            <RunTestsPopover
              count={run.passed}
              projectSlug={projectSlug}
              runHref={href}
              runId={run.id}
              teamSlug={teamSlug}
              variant="passed"
            />
            {run.failed > 0 ? (
              <RunTestsPopover
                count={run.failed}
                projectSlug={projectSlug}
                runHref={href}
                runId={run.id}
                teamSlug={teamSlug}
                variant="failed"
              />
            ) : null}
            {run.flaky > 0 ? (
              <RunTestsPopover
                count={run.flaky}
                projectSlug={projectSlug}
                runHref={href}
                runId={run.id}
                teamSlug={teamSlug}
                variant="flaky"
              />
            ) : null}
            <span className="ml-auto text-[color:var(--fg-4)]">/{total}</span>
          </div>
        </div>
      </TableCell>

      <TableCell className="w-[90px] px-4 py-3 text-right align-middle font-mono text-[12px] tabular-nums text-muted-foreground">
        <LiveDuration
          completedAt={run.completedAt}
          createdAt={run.createdAt}
          durationMs={run.durationMs}
          status={run.status}
        />
      </TableCell>

      <TableCell className="w-[100px] px-4 py-3 text-right align-middle text-[12px] text-muted-foreground">
        {formatRelativeTime(run.createdAt)}
      </TableCell>
    </TableRow>
  );
}

function BranchPill({
  name,
  href,
}: {
  name: string;
  href: string | null;
}): React.ReactElement {
  const content = (
    <>
      <GitBranch className="size-3 shrink-0" strokeWidth={2} />
      <span className="truncate">{name}</span>
    </>
  );
  const className =
    "relative z-10 inline-flex max-w-[180px] items-center gap-1 rounded-full border border-line-1 bg-bg-2 px-2 py-px font-mono text-[11.5px] leading-[18px] text-fg-2 hover:text-foreground";
  return href ? (
    <a
      className={className}
      href={href}
      onClick={(e) => e.stopPropagation()}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  ) : (
    <span className={className}>{content}</span>
  );
}

function PrPill({
  num,
  href,
}: {
  num: number;
  href: string | null;
}): React.ReactElement {
  const content = (
    <>
      <GitPullRequest className="size-3 shrink-0" strokeWidth={2} />#{num}
    </>
  );
  const className =
    "relative z-10 inline-flex shrink-0 items-center gap-1 rounded-full border border-line-1 bg-bg-2 px-2 py-px text-[11.5px] leading-[18px] text-fg-2 hover:text-foreground";
  return href ? (
    <a
      className={className}
      href={href}
      onClick={(e) => e.stopPropagation()}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  ) : (
    <span className={className}>{content}</span>
  );
}

function EnvPill({ env }: { env: string }): React.ReactElement {
  // Production gets a warm tint; staging picks up the accent; everything else
  // lands on the neutral raised surface.
  const tone: { bg: string; fg: string } =
    env === "production"
      ? { bg: "oklch(0.70 0.20 24 / 0.14)", fg: "oklch(0.78 0.20 24)" }
      : env === "staging"
        ? { bg: "var(--accent-soft)", fg: "var(--accent)" }
        : { bg: "var(--bg-3)", fg: "var(--fg-2)" };
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-[4px] px-2 py-px font-mono text-[11px] font-medium tracking-[0.2px]"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {env}
    </span>
  );
}

function CommitPill({
  sha,
  href,
}: {
  sha: string;
  href: string | null;
}): React.ReactElement {
  const short = sha.slice(0, 7);
  const className =
    "relative z-10 inline-flex shrink-0 items-center gap-1 font-mono text-[11.5px] text-fg-3 hover:text-foreground";
  return href ? (
    <a
      className={className}
      href={href}
      onClick={(e) => e.stopPropagation()}
      rel="noreferrer"
      target="_blank"
      title="View commit"
    >
      <span className="size-1 rounded-full bg-fg-4" />
      {short}
    </a>
  ) : (
    <span className={className}>
      <span className="size-1 rounded-full bg-fg-4" />
      {short}
    </span>
  );
}
