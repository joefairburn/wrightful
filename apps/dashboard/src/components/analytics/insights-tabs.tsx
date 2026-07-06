import { Link, PREFETCH_STABLE } from "@/components/ui/link";
import { underlineTabClasses } from "@/components/underline-tabs";

export type InsightsTabKey =
  | "run-status"
  | "suite-size"
  | "run-duration"
  | "slowest-tests";

export interface InsightsTabsProps {
  teamSlug: string;
  projectSlug: string;
  active: InsightsTabKey;
  /** Carry the active range param across tab nav so it stays selected. */
  range?: string;
  /** Carry the active branch param across tab nav so it stays selected. */
  branch?: string | null;
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
  range,
  branch,
}: InsightsTabsProps) {
  const base = `/t/${teamSlug}/p/${projectSlug}/insights`;
  const qs = new URLSearchParams();
  if (range) qs.set("range", range);
  if (branch) qs.set("branch", branch);
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  const withQs = (path: string) => `${path}${suffix}`;
  const tabs: { key: InsightsTabKey; label: string; href: string }[] = [
    { key: "run-status", label: "Run Status", href: withQs(base) },
    {
      key: "suite-size",
      label: "Suite Size",
      href: withQs(`${base}/suite-size`),
    },
    {
      key: "run-duration",
      label: "Run Duration",
      href: withQs(`${base}/run-duration`),
    },
    {
      key: "slowest-tests",
      label: "Slowest Tests",
      href: withQs(`${base}/slowest-tests`),
    },
  ];

  return (
    <div className="-mb-px flex items-center gap-1 border-b border-line-1 bg-background px-6">
      {tabs.map((t) => (
        <Link
          cacheFor={PREFETCH_STABLE}
          className={underlineTabClasses(active === t.key, "-mb-px")}
          href={t.href}
          key={t.key}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
