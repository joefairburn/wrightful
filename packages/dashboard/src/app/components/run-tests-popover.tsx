"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Minus, TriangleAlert, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import type { TestPreviewResponse } from "@/routes/api/run-test-preview";

type Variant = "failed" | "flaky" | "passed" | "skipped";

type Props = {
  variant: Variant;
  count: number;
  teamSlug: string;
  projectSlug: string;
  runId: string;
  runHref: string;
};

const TRIGGER_BADGE: Record<Variant, string> = {
  failed:
    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-destructive/8 text-destructive-foreground font-mono text-[11px] font-semibold border border-destructive/20 dark:bg-destructive/16 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-destructive/12 dark:hover:bg-destructive/24 relative z-10",
  flaky:
    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-warning/8 text-warning-foreground font-mono text-[11px] border border-warning/20 dark:bg-warning/16 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-warning/12 dark:hover:bg-warning/24 relative z-10",
  passed:
    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-success/8 text-success-foreground font-mono text-[11px] border border-success/20 dark:bg-success/16 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-success/12 dark:hover:bg-success/24 relative z-10",
  skipped:
    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground font-mono text-[11px] border border-muted-foreground/20 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-muted/80 relative z-10",
};

const VARIANT_LABEL: Record<Variant, string> = {
  failed: "failed",
  flaky: "flaky",
  passed: "passed",
  skipped: "skipped",
};

const VARIANT_ICON: Record<Variant, { Icon: LucideIcon; strokeWidth: number }> =
  {
    failed: { Icon: X, strokeWidth: 3 },
    flaky: { Icon: TriangleAlert, strokeWidth: 2.5 },
    passed: { Icon: Check, strokeWidth: 3 },
    skipped: { Icon: Minus, strokeWidth: 2.5 },
  };

function buildUrl(
  teamSlug: string,
  projectSlug: string,
  runId: string,
): string {
  return `/api/t/${encodeURIComponent(teamSlug)}/p/${encodeURIComponent(projectSlug)}/runs/${encodeURIComponent(runId)}/test-preview`;
}

async function fetchTestPreview(url: string): Promise<TestPreviewResponse> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Failed to load test preview (${res.status})`);
  const body: TestPreviewResponse = await res.json();
  return body;
}

export function RunTestsPopover({
  variant,
  count,
  teamSlug,
  projectSlug,
  runId,
  runHref,
}: Props): React.ReactElement | null {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const queryKey = ["run-test-preview", teamSlug, projectSlug, runId] as const;
  const url = buildUrl(teamSlug, projectSlug, runId);

  const prefetch = useCallback(() => {
    void queryClient.prefetchQuery({
      queryKey,
      queryFn: () => fetchTestPreview(url),
      staleTime: 15_000,
    });
  }, [queryClient, queryKey, url]);

  const { data, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchTestPreview(url),
    enabled: isOpen,
    staleTime: 15_000,
  });

  if (count === 0) return null;

  const items = data?.[variant];
  const { Icon, strokeWidth } = VARIANT_ICON[variant];
  const isLoading = isOpen && !data && !isError;

  return (
    <Popover onOpenChange={setIsOpen}>
      <PopoverTrigger
        className={TRIGGER_BADGE[variant]}
        onPointerEnter={prefetch}
        onFocus={prefetch}
      >
        <Icon size={10} strokeWidth={strokeWidth} />
        {count}
      </PopoverTrigger>
      <PopoverPopup className="w-96 p-0" align="start" side="bottom">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-xs font-semibold tracking-tight">
            {isLoading || !items
              ? `${count} ${VARIANT_LABEL[variant]} tests`
              : `Showing ${items.length} of ${count} ${VARIANT_LABEL[variant]} tests`}
          </h3>
        </div>

        {isError ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            <p>Couldn't load tests.</p>
            <button
              type="button"
              className="mt-2 font-mono text-[11px] underline hover:text-foreground"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </div>
        ) : isLoading || !items ? (
          <ul className="divide-y divide-border/60">
            {[0, 1, 2].map((i) => (
              <li key={i} className="px-4 py-2.5">
                <div className="h-3 w-3/4 rounded-sm bg-muted animate-pulse" />
                <div className="mt-1.5 h-2.5 w-1/2 rounded-sm bg-muted/60 animate-pulse" />
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            No {VARIANT_LABEL[variant]} tests found.
          </div>
        ) : (
          <ul className="divide-y divide-border/60 max-h-80 overflow-y-auto">
            {items.map((item) => {
              const testHref = `${runHref}/tests/${item.id}`;
              return (
                <li key={item.id}>
                  <a
                    href={testHref}
                    className="block px-4 py-2.5 hover:bg-muted/40 transition-colors"
                  >
                    <div className="text-xs font-medium truncate">
                      {item.title}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground truncate">
                      {item.projectName ? `${item.projectName} · ` : ""}
                      {item.file}
                    </div>
                    {variant === "failed" && item.errorMessage ? (
                      <div className="mt-1 font-mono text-[11px] text-destructive-foreground/80 line-clamp-2">
                        {item.errorMessage}
                      </div>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ul>
        )}

        <div className="px-4 py-2.5 border-t border-border bg-muted/20">
          <a
            href={runHref}
            className="inline-flex items-center gap-1 text-xs font-medium hover:underline"
          >
            View full report
            <ArrowRight size={12} strokeWidth={2} />
          </a>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
