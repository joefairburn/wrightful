import { Link } from "@void/react";
import type React from "react";
import { ActorAvatar } from "@/components/actor-avatar";
import {
  QuarantineCell,
  type QuarantineState,
} from "@/components/quarantine-cell";
import { Sparkline, type SparklinePoint } from "@/components/sparkline";
import { StatusGlyph } from "@/components/status-glyph";
import { TableCell, TableRow } from "@/components/ui/table";
import { stripAnsi } from "@/lib/ansi";
import { formatRelativeTime } from "@/lib/time-format";

export interface FlakyRecentFailure {
  testResultId: string;
  runId: string;
  commitSha: string | null;
  branch: string | null;
  actor: string | null;
  createdAt: number;
  errorMessage: string | null;
  errorStack: string | null;
}

export interface FlakyTestRowProps {
  testId: string;
  title: string;
  file: string;
  tags: string[];
  pct: number;
  rangeDays: number;
  sparklinePoints: SparklinePoint[];
  recentFailures: FlakyRecentFailure[];
  /** Where the row click lands — typically the most recent failure's
   * test-detail page, falling back to the project base. */
  rowHref: string;
  /** Quarantine state for this test (null = not quarantined) + the controls. */
  quarantine: QuarantineState | null;
  quarantineActionPath: string;
  quarantineRedirectTo: string;
  canManageQuarantine: boolean;
}

function pctTone(pct: number): string {
  if (pct >= 20) return "var(--fail)";
  if (pct >= 5) return "var(--flaky)";
  return "var(--muted-foreground)";
}

/**
 * Strip the file path prefix from the title if Playwright captured it
 * that way. Our reporter sometimes stores titles like
 * `"flaky.spec.ts > Promo codes > validates …"`; the design wants just
 * `"Promo codes > validates …"` on the top line.
 */
function displayTitle(title: string, file: string): string {
  if (!file) return title;
  const prefix = `${file} > `;
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

/**
 * Flaky test row. Layout mirrors the design bundle's `FlakyRow`
 * (`wrightful/project/screen-flaky-tests.jsx:84-122`):
 *   [glyph 40] [Test flex] [Flake rate 110 r] [Nd trend 180] [Last failure 280] [Owner 120] [Last seen 90 r]
 *
 * Test cell is two lines:
 *   - Line 1 (sans 13px, weight 450): describe-path + test title.
 *   - Line 2 (mono 11px muted): file path + tags inline (`gap: 8`).
 * Tags pick up `var(--running)` (the indigo accent — same hex the
 * design's `--accent` token holds).
 *
 * X-padding matches the runs table (`px-4`).
 */
export function FlakyTestRow({
  testId,
  title,
  file,
  tags,
  pct,
  rangeDays,
  sparklinePoints,
  recentFailures,
  rowHref,
  quarantine,
  quarantineActionPath,
  quarantineRedirectTo,
  canManageQuarantine,
}: FlakyTestRowProps): React.ReactElement {
  const tone = pctTone(pct);
  const latest = recentFailures[0];
  const cleanTitle = displayTitle(title, file);

  return (
    <TableRow>
      <TableCell className="w-10 px-4 align-middle">
        <Link
          className="flex items-center justify-center focus-visible:outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring"
          href={rowHref}
        >
          <span className="sr-only">View {cleanTitle}</span>
          <StatusGlyph size={14} status="flaky" />
        </Link>
      </TableCell>
      <TableCell className="px-4 py-3 align-middle">
        <div className="min-w-0">
          <div
            className="truncate text-[13px] font-[450] text-foreground"
            title={cleanTitle}
          >
            {cleanTitle}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate" title={file}>
              {file}
            </span>
            {tags.map((t) => (
              <span
                className="shrink-0"
                key={t}
                style={{ color: "var(--running)" }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </TableCell>
      <TableCell className="w-[110px] px-4 py-3 text-right align-middle">
        <div
          className="font-mono text-[13px] font-semibold tabular-nums"
          style={{ color: tone }}
        >
          {pct.toFixed(0)}%
        </div>
        <div className="mt-0.5 text-[10.5px] text-muted-foreground">
          over {rangeDays}d
        </div>
      </TableCell>
      <TableCell className="w-[180px] px-4 py-3 align-middle">
        <Sparkline height={22} points={sparklinePoints} width={160} />
      </TableCell>
      <TableCell className="w-[280px] max-w-[280px] px-4 py-3 align-middle">
        <div
          className="truncate font-mono text-[11.5px] text-muted-foreground"
          title={latest?.errorMessage ? stripAnsi(latest.errorMessage) : ""}
        >
          {latest?.errorMessage
            ? stripAnsi(latest.errorMessage.split("\n")[0] ?? "")
            : "—"}
        </div>
      </TableCell>
      <TableCell className="w-[120px] px-4 py-3 align-middle">
        {latest?.actor ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <ActorAvatar actor={latest.actor} size={16} />
            <span className="truncate text-[12px] text-fg-2">
              {latest.actor}
            </span>
          </div>
        ) : (
          <span className="text-[12px] text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="w-[90px] px-4 py-3 text-right align-middle text-[12px] text-muted-foreground">
        {latest ? formatRelativeTime(latest.createdAt) : "—"}
      </TableCell>
      <TableCell className="w-[170px] px-4 py-3 align-middle">
        <QuarantineCell
          actionPath={quarantineActionPath}
          canManage={canManageQuarantine}
          quarantine={quarantine}
          redirectTo={quarantineRedirectTo}
          testId={testId}
          title={cleanTitle}
        />
      </TableCell>
    </TableRow>
  );
}
