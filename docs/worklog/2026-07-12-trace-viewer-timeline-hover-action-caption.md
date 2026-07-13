# 2026-07-12 — Trace viewer: action caption on the timeline hover preview

## What changed

The timeline scrubber's hover-preview card now shows the **action active at the
hovered time** underneath the screenshot thumbnail — the action title (e.g.
`Expect "toHaveText"`) over its selector/URL/expression, dimmed — matching the
official Playwright trace viewer's hover popover.

Previously the hover card showed only the screencast thumbnail + the time
offset label. Hovering the strip already resolves an action to seek to on
click; we now surface that same action's title + param hint as a two-line
caption so you can read what a click would land on without clicking.

## Details

- **`src/trace-viewer/model.ts`** — extracted `actionParamHint(action)` (the
  selector → url → expression fallback that produces the dimmed second line)
  out of `action-list.tsx` and exported it alongside `actionTitle`, so the
  timeline and the action list share one implementation.
- **`src/trace-viewer/components/action-list.tsx`** — dropped its local copy of
  `actionParamHint` and imports the shared one from `../model`.
- **`src/trace-viewer/components/timeline.tsx`** — computes `hoverAction` via
  the existing `actionActiveAt(playableActions, hoverTime)` (the _same_ set and
  resolver `seekToFraction` uses, so the caption always names the action a
  click would actually select), and passes its `title`/`hint` into
  `HoverPreview`. The card renders them as a title line (`text-fg-2`) over a
  mono selector line (`text-fg-4`), both truncated and constrained to the frame
  width so a long selector doesn't stretch the card. The caption only renders
  when there's a screencast frame preview (the frameless fallback keeps its
  plain mono offset label unchanged).

## Verification

- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/trace-viewer`
  — 156 tests pass (20 files). Added a case to
  `trace-viewer-timeline.test.tsx` asserting a hover at fraction 0.5 (model
  time 3000) captions the card with `Expect "toHaveText"` + `#total`.
- `pnpm check` — 0 errors (format + lint + type-check).
