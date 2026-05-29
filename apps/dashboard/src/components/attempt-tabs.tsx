import type React from "react";
import { cn } from "@/lib/cn";
import { useSearchParam } from "@/lib/use-search-param";

/**
 * URL-driven attempt tabs for the test detail page.
 *
 * `AttemptTabsBar` writes `?attempt=<n>`, every `AttemptPanel` reads it.
 * The tabs bar and each panel sync via the URL — same pattern as the
 * run-detail status filter. URL-driven (rather than React state) so the
 * selection survives bookmarks and is shareable.
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
  const [raw, setRaw] = useSearchParam("attempt", defaultValue);
  // Fall back to default if the URL value isn't a known attempt (e.g. stale
  // share link, or attempt list shrank between renders).
  const active = items.includes(raw) ? raw : defaultValue;
  return [active, setRaw];
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
