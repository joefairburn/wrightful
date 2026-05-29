import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { cn } from "@/lib/cn";
import { buildPageWindow } from "@/lib/page-window";

export interface TablePaginationFooterProps {
  /** 1-indexed start row of the current page (0 when there are no items). */
  fromRow: number;
  /** 1-indexed end row of the current page (0 when there are no items). */
  toRow: number;
  /** Total item count across all pages. */
  totalCount: number;
  currentPage: number;
  totalPages: number;
  /** Singular noun used in the summary, e.g. `"test"` → "tests". */
  itemNoun: string;
  pageHref: (page: number) => string;
  /** Override the wrapper class, e.g. for in-card embedding. */
  className?: string;
}

/**
 * Footer strip for paginated tables: "Showing X–Y of N items" on the
 * left, page-number Pagination on the right. Used by tests / slowest-
 * tests / runs-list.
 *
 * Caller is responsible for hiding the footer when there's only one
 * page (most callers do; not all).
 */
export function TablePaginationFooter({
  fromRow,
  toRow,
  totalCount,
  currentPage,
  totalPages,
  itemNoun,
  pageHref,
  className,
}: TablePaginationFooterProps): React.ReactElement {
  const pageWindow = buildPageWindow(currentPage, totalPages);
  const plural = totalCount === 1 ? itemNoun : `${itemNoun}s`;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 border-t border-border shrink-0 px-6 py-3 text-xs font-mono text-muted-foreground",
        className,
      )}
    >
      <span>
        {totalCount === 0
          ? `No ${plural}`
          : `Showing ${fromRow}–${toRow} of ${totalCount.toLocaleString()} ${plural}`}
      </span>
      {totalPages > 1 && (
        <Pagination className="mx-0 w-auto justify-end">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href={currentPage > 1 ? pageHref(currentPage - 1) : undefined}
                aria-disabled={currentPage === 1}
                className={cn(
                  currentPage === 1 && "pointer-events-none opacity-50",
                )}
              />
            </PaginationItem>
            {pageWindow.map((entry, i) =>
              entry === "ellipsis" ? (
                <PaginationItem key={`ellipsis-${i}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={entry}>
                  <PaginationLink
                    href={pageHref(entry)}
                    isActive={entry === currentPage}
                  >
                    {entry}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}
            <PaginationItem>
              <PaginationNext
                href={
                  currentPage < totalPages
                    ? pageHref(currentPage + 1)
                    : undefined
                }
                aria-disabled={currentPage >= totalPages}
                className={cn(
                  currentPage >= totalPages && "pointer-events-none opacity-50",
                )}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
