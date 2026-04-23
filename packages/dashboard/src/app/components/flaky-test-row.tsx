"use client";

import { ChevronRight } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Sparkline, type SparklinePoint } from "@/app/components/sparkline";
import { TestErrorAlert } from "@/app/components/test-error-alert";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/time-format";

export interface FlakyRecentFailure {
  testResultId: string;
  runId: string;
  commitSha: string | null;
  branch: string | null;
  createdAt: number;
  errorMessage: string | null;
  errorStack: string | null;
}

export interface FlakyTestRowProps {
  rank: number;
  testId: string;
  title: string;
  file: string;
  total: number;
  flakyCount: number;
  pct: number;
  sparklinePoints: SparklinePoint[];
  recentFailures: FlakyRecentFailure[];
  /** Base route `/t/:team/p/:project` — used to compose per-failure links. */
  projectBase: string;
  /** Fallback destination when the title is clicked; typically the latest failure. */
  historyHref: string;
}

function pctTone(pct: number): {
  text: string;
  border: string;
} {
  if (pct >= 20)
    return {
      text: "text-destructive-foreground",
      border: "border-l-destructive",
    };
  if (pct >= 5)
    return {
      text: "text-warning-foreground",
      border: "border-l-warning",
    };
  return {
    text: "text-muted-foreground",
    border: "border-l-border",
  };
}

export function FlakyTestRow({
  rank,
  title,
  file,
  total,
  flakyCount,
  pct,
  sparklinePoints,
  recentFailures,
  projectBase,
  historyHref,
}: FlakyTestRowProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const tone = pctTone(pct);

  return (
    <>
      <tr
        className={cn(
          "border-b border-border/50 border-l-2 cursor-pointer transition-colors hover:bg-muted/30",
          tone.border,
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <td className="px-4 py-3 text-center text-xs font-mono text-muted-foreground w-12">
          #{rank}
        </td>
        <td className="px-4 py-3 max-w-md">
          <a
            href={historyHref}
            className="block truncate font-mono text-sm text-foreground hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {title}
          </a>
          <div className="text-xs text-muted-foreground truncate font-mono mt-0.5">
            {file}
          </div>
        </td>
        <td className="px-4 py-3 text-right w-28">
          <span className={cn("font-bold text-base", tone.text)}>
            {pct.toFixed(1)}%
          </span>
        </td>
        <td className="px-4 py-3 text-right w-28 text-muted-foreground font-mono text-xs tabular-nums">
          {flakyCount} / {total}
        </td>
        <td className="px-4 py-3 w-48">
          <Sparkline points={sparklinePoints} width={160} height={24} />
        </td>
        <td className="px-4 py-3 text-center w-10 text-muted-foreground">
          <ChevronRight
            size={14}
            className={cn("transition-transform", open && "rotate-90")}
          />
        </td>
      </tr>
      {open && (
        <tr className="border-b-4 border-background bg-muted/10">
          <td colSpan={6} className="p-0">
            <div className="p-6 pl-16">
              <h4 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-3">
                Recent Failures ({recentFailures.length})
              </h4>
              {recentFailures.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No recent failures captured.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {recentFailures.map((f) => {
                    const href = `${projectBase}/runs/${f.runId}/tests/${f.testResultId}?attempt=0`;
                    return (
                      <div
                        key={f.testResultId}
                        className="flex flex-col gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <a
                          href={href}
                          className="flex items-center justify-between gap-4 text-xs hover:text-foreground transition-colors"
                        >
                          <div className="flex items-center gap-2 min-w-0 font-mono">
                            <span className="size-2 rounded-full bg-destructive shrink-0" />
                            <span className="text-foreground font-medium truncate hover:underline">
                              Run{" "}
                              {f.commitSha
                                ? f.commitSha.slice(0, 7)
                                : f.runId.slice(0, 8)}
                            </span>
                            {f.branch && (
                              <span className="text-muted-foreground truncate">
                                {f.branch}
                              </span>
                            )}
                          </div>
                          <span className="text-muted-foreground shrink-0 font-mono">
                            {formatRelativeTime(f.createdAt)}
                          </span>
                        </a>
                        {f.errorMessage ? (
                          <TestErrorAlert
                            errorMessage={f.errorMessage}
                            errorStack={f.errorStack}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
