# 2026-07-12 — Trace viewer: Network tab search, resource-type filter tabs, sortable headers

## What changed

The trace viewer's Network tab gained a DevTools-style filter toolbar above the
request table: a URL-substring search field plus segmented type tabs — **All /
Fetch / HTML / JS / CSS / Font / Image / WS**. Both filters compose with the
existing action-window scoping (crosshair toggle), and filtering out the
currently selected row hides its detail panel (it comes back when the filter is
relaxed, same behavior as scoping).

The table's column headers are now sortable, each click cycling ascending →
descending → back to the trace's natural request-start order, and the column
order changed to put **Name** first (DevTools order: Name / Status / Method /
Type / Size / Duration).

## Details

- **`src/trace-viewer/components/network-tab.tsx`**
  - New `resourceTypeOf(entry)` classifier: the browser-reported HAR
    `_resourceType` is authoritative when present (`fetch`/`xhr`/`eventsource`
    → Fetch, `document` → HTML, `script` → JS, `stylesheet` → CSS, `font` →
    Font, `image` → Image, `websocket` / `_webSocketMessages` → WS); traces
    without it fall back to the response mime type (with `json` bucketed under
    Fetch). Entries matching no category only show under **All**.
  - Toolbar uses the shared chrome: `SearchFilterInput` (like the action list's
    filter) + `SegmentedControl` (compact). Filtered-to-nothing shows the shared
    `TabNotice` ("No matching requests.") while keeping the toolbar visible so
    the filters can be cleared; the trace-has-no-requests case keeps the
    existing `ScopedEmpty` full empty state.
  - Sortable headers: a local `SortableHead` wrapper around `TableHead` (no
    shared sortable-header component exists yet in `ui/`) with `aria-sort` and
    a chevron in an always-rendered icon slot (no layout shift). Sort values
    match what each column displays (`SORT_ACCESSORS` — e.g. Name sorts on the
    shortened URL, Size on the same content-size-else-body-size fallback the
    cell renders); numbers compare numerically, strings via `localeCompare`.
    Sorting applies after filtering; clearing it restores natural order.
  - Column order: Name / Status / Method / Type / Size / Duration. The Size and
    Type cell expressions were extracted to `entrySize` / `entryMimeType` so
    the cells and sort accessors can't drift apart.
  - Accessibility pass on the table itself: - Rows were click-only (`onClick` on the `<tr>`, no keyboard path) with an
    invalid `aria-selected` (only valid on grid rows). Replaced with the
    RowLink stretched-target pattern as a **button**: a real `<button>` in
    the Name cell whose `after:inset-0` pseudo fills the `relative`
    `TableRow`, so the whole row stays the pointer target while keyboard
    focus, the accessible name (the request name), and proper disclosure
    semantics (`aria-expanded` + `aria-controls` → the detail panel's id)
    live on a real control. - Sort-header buttons got the codebase-convention `focus-visible:ring-2
ring-ring` (inset — full-bleed inside the sticky header). - Closing the detail panel via its X returns focus to the opening row's
    button instead of dropping it on an unmounted element. - Fixed a remount bug this surfaced: opening/closing the panel swapped the
    wrapper JSX around the table, remounting it (resetting scroll position
    and detaching the focused row button). The split-pane wrapper is now
    structurally stable; only the panel half mounts/unmounts.
- **`src/trace-viewer/har-fields.ts`** — added `harResourceType` and
  `webSocketMessages` typed accessors for the underscore-prefixed HAR extension
  fields (same pattern as `monotonicTime`/`contentSha1`/`transferSize`).

## Verification

- `src/__tests__/trace-viewer-network-tab.test.tsx` — 8 new tests: URL search
  filtering + clearing, type-tab filtering (including the mime fallback for an
  entry with no `_resourceType` and the empty-type inline notice),
  detail-panel auto-close when the selected row is filtered out, the Name-first
  column order + asc/desc/natural sort cycle (with `aria-sort` assertions),
  numeric duration sorting, keyboard open/close via the row's disclosure
  button (asserting `aria-expanded`/`aria-controls`), and focus restoration on
  panel close. 13/13 pass.
- `pnpm check` exit 0 (format + lint + typecheck).
- Adjacent suites (`trace-viewer-detail-tabs`, `trace-viewer-hooks`) still pass
  (42/42 across the three files).
