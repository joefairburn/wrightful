import { Link, PREFETCH_STABLE } from "@/components/ui/link";
import {
  SEGMENTED_GROUP_CLASSES,
  segmentedItemClasses,
} from "@/components/segmented-control";
import { cn } from "@/lib/cn";

export interface AnalyticsButtonGroupProps<T extends string> {
  options: readonly T[];
  value: T;
  hrefFor: (v: T) => string;
  /** Optional per-option label override (defaults to the value itself). */
  labelFor?: (v: T) => string;
  className?: string;
}

/**
 * Anchor-based segmented button group backing a URL query param. RSC-safe
 * (no client JS needed — navigation re-runs the RSC and updates
 * highlighting via `value`).
 *
 * Visually identical to `<SegmentedControl>` — both render through the shared
 * class helpers in `segmented-control.tsx` — but selection happens by link,
 * not by state, so navigation cost stays cheap.
 */
export function AnalyticsButtonGroup<T extends string>({
  options,
  value,
  hrefFor,
  labelFor,
  className,
}: AnalyticsButtonGroupProps<T>) {
  return (
    <div className={cn(SEGMENTED_GROUP_CLASSES, className)}>
      {options.map((o) => (
        <Link
          key={o}
          cacheFor={PREFETCH_STABLE}
          href={hrefFor(o)}
          className={segmentedItemClasses(value === o)}
        >
          {labelFor ? labelFor(o) : o}
        </Link>
      ))}
    </div>
  );
}
