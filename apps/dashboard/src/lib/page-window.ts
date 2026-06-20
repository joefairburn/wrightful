/**
 * Compute the visible page numbers for a paginated table footer:
 * always includes the first and last page, the current page +/- 1, and
 * inserts `"ellipsis"` markers where the window doesn't reach the edge.
 *
 * Returns the full sequence (no ellipses) when total <= 7, since there's
 * nothing to elide.
 */
export function buildPageWindow(
  current: number,
  total: number,
): Array<number | "ellipsis"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: Array<number | "ellipsis"> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push("ellipsis");
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push("ellipsis");
  pages.push(total);
  return pages;
}

export interface ResolveOffsetPageInput {
  /** Total matching rows across all pages (e.g. `count(*)`). */
  total: number;
  /** Rows per page; call sites differ (50 for tests/audit, 20 for slowest). */
  pageSize: number;
  /** The `?page=` value the client asked for (already coerced to >= 1). */
  requestedPage: number;
  /**
   * Number of rows actually returned for the resolved page. Pass it once the
   * slice is fetched so `toRow` reflects the real count; omit it (or pass
   * `null`) when you only need the loader half (`currentPage`/`totalPages`/
   * `offset`) to drive the query — `toRow` is then `offset` (the row before
   * the slice). The runs-list loader is a deliberate partial adopter: it owns
   * `fromRow`/`toRow` itself because they fold in live-row `newCount`.
   */
  rowCount?: number | null;
}

export interface ResolveOffsetPageResult {
  /** `requestedPage` clamped to `[1, totalPages]`. */
  currentPage: number;
  /** `max(1, ceil(total / pageSize))` — never below 1, even for an empty set. */
  totalPages: number;
  /** Zero-based SQL offset for the resolved page: `(currentPage - 1) * pageSize`. */
  offset: number;
  /** 1-based index of the first visible row, or `0` when there are no rows. */
  fromRow: number;
  /** 1-based index of the last visible row: `offset + rowCount`. */
  toRow: number;
}

/**
 * The arithmetic half of offset pagination, factored out of the table loaders
 * that all re-derived it inline (the tests catalog, the slowest-tests insight,
 * and the team audit log). The rendering half — `buildPageWindow` above +
 * `TablePaginationFooter` — was already a deep, tested seam; this is its
 * loader-side mirror.
 *
 * Out-of-range behaviour is decided ONCE here: an out-of-range `?page=` is
 * CLAMPED to `totalPages`, and `fromRow`/`toRow` are computed against the
 * clamped page — so a too-large page shows the last page's window rather than
 * "Showing 0 of N". Call sites that previously diverged (audit/slowest showed
 * "Showing 0 of N" for an over-the-end page) now all match the clamped-last
 * behaviour the tests catalog had.
 *
 * Note this clamps the page number but does NOT re-run the query: a caller that
 * fetched its slice using the *requested* offset can get back an empty slice on
 * an over-the-end page even though `currentPage` is now the last page. Callers
 * that want the slice to match the clamped page must re-fetch at `offset` when
 * the first fetch came back empty — see `shouldRefetchClampedPage`.
 */
export function resolveOffsetPage({
  total,
  pageSize,
  requestedPage,
  rowCount,
}: ResolveOffsetPageInput): ResolveOffsetPageResult {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(requestedPage, 1), totalPages);
  const offset = (currentPage - 1) * pageSize;
  const rows = rowCount ?? 0;
  const fromRow = total === 0 ? 0 : offset + 1;
  const toRow = offset + rows;
  return { currentPage, totalPages, offset, fromRow, toRow };
}

/**
 * Whether a loader should re-fetch its slice at the clamped offset. True when
 * an over-the-end page was requested (so `currentPage` got clamped below
 * `requestedPage`) but rows do exist — i.e. the first fetch, run at the
 * requested offset, came back empty. Lets the over-the-end page actually show
 * the last page's rows instead of an empty table under a clamped footer.
 *
 * This is the "refetch the last page when the slice came back empty" dance the
 * tests catalog open-coded; exposed as an explicit, documented option because
 * the other adopters don't need it (their empty-slice case is benign).
 */
export function shouldRefetchClampedPage(input: {
  total: number;
  requestedPage: number;
  currentPage: number;
  fetchedRowCount: number;
}): boolean {
  return (
    input.total > 0 &&
    input.fetchedRowCount === 0 &&
    input.requestedPage > input.currentPage
  );
}
