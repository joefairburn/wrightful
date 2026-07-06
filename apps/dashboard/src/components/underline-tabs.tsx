import { cn } from "@/lib/cn";

/**
 * Shared item classes for the flat underline-tab pattern — the run-detail
 * section tabs, the test-detail attempt tabs, and the Insights sub-nav all
 * render through this so the tab typography and the accent underline exist
 * once. Callers own the container (border-b bar, sticky positioning,
 * overflow) and any 1px alignment shim (`-mb-px`) via `className`.
 *
 * The underline sits INSIDE the item box (`after:bottom-0`, not
 * `after:-bottom-px`) so containers that clip overflow (the attempt bar's
 * `overflow-x-auto`) can't cut it off; sit the item on the container's
 * bottom border with `-mb-px` (link bars) or `items-end` (button bars).
 */
export function underlineTabClasses(
  active: boolean,
  className?: string,
): string {
  return cn(
    "relative inline-flex items-center gap-2 whitespace-nowrap rounded-sm px-3 py-2 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "font-medium text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[var(--running)] after:content-['']"
      : "text-fg-3 hover:text-foreground",
    className,
  );
}
