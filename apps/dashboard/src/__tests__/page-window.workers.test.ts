import { describe, expect, it } from "vite-plus/test";
import {
  buildPageWindow,
  resolveOffsetPage,
  shouldRefetchClampedPage,
} from "@/lib/page-window";

describe("buildPageWindow", () => {
  it("returns the full sequence with no ellipses when total <= 7", () => {
    expect(buildPageWindow(1, 1)).toEqual([1]);
    expect(buildPageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(buildPageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("returns an empty sequence for zero pages", () => {
    expect(buildPageWindow(1, 0)).toEqual([]);
  });

  it("elides only the right side when current is near the start", () => {
    expect(buildPageWindow(1, 10)).toEqual([1, 2, "ellipsis", 10]);
    expect(buildPageWindow(2, 10)).toEqual([1, 2, 3, "ellipsis", 10]);
    // current=3 → window reaches page 2, so no left ellipsis yet.
    expect(buildPageWindow(3, 10)).toEqual([1, 2, 3, 4, "ellipsis", 10]);
  });

  it("elides only the left side when current is near the end", () => {
    expect(buildPageWindow(10, 10)).toEqual([1, "ellipsis", 9, 10]);
    expect(buildPageWindow(9, 10)).toEqual([1, "ellipsis", 8, 9, 10]);
    // current=8 → window reaches page 9, so no right ellipsis.
    expect(buildPageWindow(8, 10)).toEqual([1, "ellipsis", 7, 8, 9, 10]);
  });

  it("elides both sides when current is in the middle", () => {
    expect(buildPageWindow(5, 10)).toEqual([
      1,
      "ellipsis",
      4,
      5,
      6,
      "ellipsis",
      10,
    ]);
    expect(buildPageWindow(50, 100)).toEqual([
      1,
      "ellipsis",
      49,
      50,
      51,
      "ellipsis",
      100,
    ]);
  });

  it("always includes the first and last page", () => {
    for (const current of [1, 4, 8, 15]) {
      const window = buildPageWindow(current, 15);
      expect(window[0]).toBe(1);
      expect(window[window.length - 1]).toBe(15);
    }
  });

  it("kicks in ellipses exactly at total = 8", () => {
    expect(buildPageWindow(1, 8)).toEqual([1, 2, "ellipsis", 8]);
    expect(buildPageWindow(4, 8)).toEqual([
      1,
      "ellipsis",
      3,
      4,
      5,
      "ellipsis",
      8,
    ]);
  });
});

describe("resolveOffsetPage", () => {
  it("resolves the first page of a full set", () => {
    expect(
      resolveOffsetPage({
        total: 120,
        pageSize: 50,
        requestedPage: 1,
        rowCount: 50,
      }),
    ).toEqual({
      currentPage: 1,
      totalPages: 3,
      offset: 0,
      fromRow: 1,
      toRow: 50,
    });
  });

  it("resolves a middle page (offset + row range)", () => {
    expect(
      resolveOffsetPage({
        total: 120,
        pageSize: 50,
        requestedPage: 2,
        rowCount: 50,
      }),
    ).toEqual({
      currentPage: 2,
      totalPages: 3,
      offset: 50,
      fromRow: 51,
      toRow: 100,
    });
  });

  it("resolves the partial last page", () => {
    expect(
      resolveOffsetPage({
        total: 120,
        pageSize: 50,
        requestedPage: 3,
        rowCount: 20,
      }),
    ).toEqual({
      currentPage: 3,
      totalPages: 3,
      offset: 100,
      fromRow: 101,
      toRow: 120,
    });
  });

  it("reports 1 total page and zero rows for an empty set", () => {
    expect(
      resolveOffsetPage({
        total: 0,
        pageSize: 50,
        requestedPage: 1,
        rowCount: 0,
      }),
    ).toEqual({
      currentPage: 1,
      totalPages: 1,
      offset: 0,
      fromRow: 0,
      toRow: 0,
    });
  });

  it("clamps an over-the-end page to the last page and shows its window", () => {
    // 120 rows / 50 per page → 3 pages. Asking for page 99 lands on page 3,
    // and fromRow/toRow reflect the clamped page (NOT "Showing 0 of N").
    expect(
      resolveOffsetPage({
        total: 120,
        pageSize: 50,
        requestedPage: 99,
        rowCount: 20,
      }),
    ).toEqual({
      currentPage: 3,
      totalPages: 3,
      offset: 100,
      fromRow: 101,
      toRow: 120,
    });
  });

  it("clamps a requested page below 1 up to page 1", () => {
    expect(
      resolveOffsetPage({
        total: 30,
        pageSize: 50,
        requestedPage: 0,
        rowCount: 30,
      }),
    ).toEqual({
      currentPage: 1,
      totalPages: 1,
      offset: 0,
      fromRow: 1,
      toRow: 30,
    });
  });

  it("rounds totalPages up for a non-multiple total", () => {
    expect(
      resolveOffsetPage({ total: 101, pageSize: 50, requestedPage: 1 })
        .totalPages,
    ).toBe(3);
    expect(
      resolveOffsetPage({ total: 100, pageSize: 50, requestedPage: 1 })
        .totalPages,
    ).toBe(2);
    expect(
      resolveOffsetPage({ total: 1, pageSize: 50, requestedPage: 1 })
        .totalPages,
    ).toBe(1);
  });

  it("honours a distinct page size", () => {
    expect(
      resolveOffsetPage({
        total: 45,
        pageSize: 20,
        requestedPage: 3,
        rowCount: 5,
      }),
    ).toEqual({
      currentPage: 3,
      totalPages: 3,
      offset: 40,
      fromRow: 41,
      toRow: 45,
    });
  });

  it("yields the loader half (toRow === offset) when rowCount is omitted", () => {
    // Callers that only need currentPage/totalPages/offset to drive a query
    // don't pass rowCount; toRow falls back to offset (the row before the slice).
    expect(
      resolveOffsetPage({ total: 120, pageSize: 50, requestedPage: 2 }),
    ).toEqual({
      currentPage: 2,
      totalPages: 3,
      offset: 50,
      fromRow: 51,
      toRow: 50,
    });
  });

  it("treats null rowCount the same as omitted", () => {
    expect(
      resolveOffsetPage({
        total: 120,
        pageSize: 50,
        requestedPage: 2,
        rowCount: null,
      }).toRow,
    ).toBe(50);
  });
});

describe("shouldRefetchClampedPage", () => {
  it("is true when an over-the-end page fetched empty but rows exist", () => {
    expect(
      shouldRefetchClampedPage({
        total: 120,
        requestedPage: 99,
        currentPage: 3,
        fetchedRowCount: 0,
      }),
    ).toBe(true);
  });

  it("is false when the requested page returned rows", () => {
    expect(
      shouldRefetchClampedPage({
        total: 120,
        requestedPage: 3,
        currentPage: 3,
        fetchedRowCount: 20,
      }),
    ).toBe(false);
  });

  it("is false on the in-range first page of an empty set", () => {
    expect(
      shouldRefetchClampedPage({
        total: 0,
        requestedPage: 1,
        currentPage: 1,
        fetchedRowCount: 0,
      }),
    ).toBe(false);
  });

  it("is false when the requested page was not clamped", () => {
    // requestedPage === currentPage → no clamp happened, so an empty slice is
    // genuine (e.g. a filtered page with no matches), not an over-the-end ask.
    expect(
      shouldRefetchClampedPage({
        total: 50,
        requestedPage: 1,
        currentPage: 1,
        fetchedRowCount: 0,
      }),
    ).toBe(false);
  });
});
