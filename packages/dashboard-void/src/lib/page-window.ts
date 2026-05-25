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
