import { Link } from "@void/react";
import { Fragment } from "react";
import type React from "react";
import { cn } from "@/lib/cn";

export interface Crumb {
  label: string;
  /** Internal route this crumb links to. Omit on the current (last) crumb. */
  href?: string;
}

/**
 * Top-of-page breadcrumb bar for nested pages (run detail, test detail). Mirrors
 * the design bundle's shell breadcrumb: a slim bordered top bar with chevron
 * separators, each crumb truncating at 280px. Crumbs with an `href` are `<Link>`s
 * (internal nav — never plain `<a>`); the final crumb is the current page,
 * rendered as a non-link emphasized label.
 *
 * Rendered by the PAGE, not the AppLayout: the labels are page data (the run's
 * short id, the test title) that the shared shell can't see, and the layout has
 * no top header to host them.
 */
export function Breadcrumbs({ items }: { items: Crumb[] }): React.ReactElement {
  return (
    <div className="flex h-11 shrink-0 items-center border-b border-border px-6">
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-fg-3"
      >
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <Fragment key={`${item.href ?? ""}-${item.label}-${i}`}>
              {item.href && !last ? (
                <Link
                  className="max-w-[280px] truncate font-normal text-fg-2 transition-colors hover:text-foreground"
                  href={item.href}
                  title={item.label}
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn(
                    "max-w-[280px] truncate",
                    last ? "font-medium text-fg-1" : "font-normal text-fg-2",
                  )}
                  title={item.label}
                >
                  {item.label}
                </span>
              )}
              {last ? null : <BreadcrumbChevron />}
            </Fragment>
          );
        })}
      </nav>
    </div>
  );
}

/** Chevron separator — matches the design bundle's shell glyph (11px, fg-4). */
function BreadcrumbChevron(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height={11}
      stroke="var(--fg-4)"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
      width={11}
    >
      <path d="M6 4 L 10 8 L 6 12" />
    </svg>
  );
}
