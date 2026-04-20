"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import type React from "react";
import { cn } from "@/lib/cn";

/**
 * URL-driven attempt tabs for the test detail page.
 *
 * Skipping Base UI's `Tabs.Root`/`TabsPanel` here on purpose: those rely on
 * a React context established on the root, and rwsdk doesn't reliably
 * propagate that context across multiple `"use client"` components that
 * are separated by server-rendered wrappers. Leaf-islands pattern instead:
 * `AttemptTabsBar` writes `?attempt=<n>`, every `AttemptPanel` reads it.
 * The tabs bar and each panel are independent client islands syncing via
 * the URL — same pattern as the run-detail status filter.
 */

type AttemptStatus = "passed" | "failed" | "skipped";

export interface AttemptTabItem {
  value: string;
  status: AttemptStatus;
  label: string;
  finalSuffix?: string | null;
}

function useActiveAttempt(
  items: readonly string[],
  defaultValue: string,
): [string, (next: string) => void] {
  const values = items.length > 0 ? items : [defaultValue];
  const [active, setActive] = useQueryState(
    "attempt",
    parseAsStringLiteral(values).withDefault(defaultValue),
  );
  const set = (next: string): void => {
    void setActive(next);
  };
  return [active, set];
}

function statusDotClass(status: AttemptStatus): string {
  if (status === "passed") return "bg-success";
  if (status === "failed") return "bg-destructive";
  return "bg-muted-foreground/50";
}

export function AttemptTabsBar({
  items,
  defaultValue,
}: {
  items: AttemptTabItem[];
  defaultValue: string;
}): React.ReactElement {
  const values = items.map((i) => i.value);
  const [active, setActive] = useActiveAttempt(values, defaultValue);
  return (
    <div className="flex gap-0 -mb-px overflow-x-auto">
      {items.map((item) => {
        const isActive = active === item.value;
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => {
              setActive(item.value);
            }}
            aria-pressed={isActive}
            className={cn(
              "inline-flex items-center gap-2 whitespace-nowrap rounded-t-md",
              "border-x border-t px-4 py-2 font-mono text-xs cursor-pointer",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "transition-colors",
              isActive
                ? "border-border bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "inline-block size-1.5 shrink-0 rounded-full",
                statusDotClass(item.status),
              )}
              aria-hidden
            />
            <span>{item.label}</span>
            {item.finalSuffix ? (
              <span className="text-muted-foreground">{item.finalSuffix}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function AttemptPanel({
  value,
  values,
  defaultValue,
  children,
  className,
}: {
  value: string;
  values: string[];
  defaultValue: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement | null {
  const [active] = useActiveAttempt(values, defaultValue);
  if (active !== value) return null;
  return <div className={className}>{children}</div>;
}
