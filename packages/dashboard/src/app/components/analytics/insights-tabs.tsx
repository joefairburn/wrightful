import { cn } from "@/lib/cn";

export type InsightsTabKey =
  | "run-status"
  | "suite-size"
  | "run-duration"
  | "slowest-tests";

export interface InsightsTabsProps {
  teamSlug: string;
  projectSlug: string;
  active: InsightsTabKey;
}

/**
 * Sub-nav shared by all Insights pages. Uses anchor links (RSC-friendly,
 * no client hydration) — selection styling is driven by the `active`
 * prop passed in by each page.
 */
export function InsightsTabs({
  teamSlug,
  projectSlug,
  active,
}: InsightsTabsProps) {
  const base = `/t/${teamSlug}/p/${projectSlug}/insights`;
  const tabs: { key: InsightsTabKey; label: string; href: string }[] = [
    { key: "run-status", label: "Run Status", href: base },
    { key: "suite-size", label: "Suite Size", href: `${base}/suite-size` },
    {
      key: "run-duration",
      label: "Run Duration",
      href: `${base}/run-duration`,
    },
    {
      key: "slowest-tests",
      label: "Slowest Tests",
      href: `${base}/slowest-tests`,
    },
  ];

  return (
    <div className="flex items-center gap-1 border-b border-border px-6">
      {tabs.map((t) => (
        <a
          key={t.key}
          href={t.href}
          className={cn(
            "relative px-3 py-2 text-sm transition-colors",
            active === t.key
              ? "text-foreground font-medium after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:bg-foreground after:content-['']"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}
