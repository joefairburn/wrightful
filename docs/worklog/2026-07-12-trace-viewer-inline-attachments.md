# 2026-07-12 — Trace viewer: open attachments inline (media lightbox)

## What changed

The Attachments tab in the custom trace viewer previously required leaving the
viewer to see any attachment content: image thumbnails linked out to a new tab
(or forced a download for base64 ones), videos had no preview at all, and only
text/JSON had an inline expand. Since we own the UI, attachments are now
viewable **inside** the viewer:

- **Images** — the existing thumbnail is now a button that opens a full-size
  in-viewer lightbox; a `View` button on the row does the same.
- **Videos** — rows get the same `View` button, opening an inline
  `<video controls autoPlay>` player in the lightbox.
- **Text/JSON** — unchanged (inline chevron expand).
- **Download** buttons are unchanged and kept on every row with reachable
  bytes.

## Details

All in `apps/dashboard/src/trace-viewer/components/attachments-tab.tsx`:

| Piece                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mediaKind(attachment)` | `image` / `video` / `null` gate — requires reachable bytes (`sha1` or `base64`), mirroring `isTextPreviewable`.                                                                                                                                                                                                                                                                                                                                        |
| `AttachmentLightbox`    | A `Dialog` nested inside the trace-viewer dialog (Base UI stacks nested dialogs, so Escape/backdrop close only the lightbox, not the replay). Bytes resolve through the bridge (`useObjectUrl` on the `sha1Path`) **deferred until open** — the path is `null` while closed, so nothing is fetched and the object URL is revoked on close. Base64 attachments render from a `data:` URL directly. Spinner while loading, quiet error state on failure. |
| `AttachmentPreview`     | The thumbnail's `<a>` wrapper (new-tab / forced-download link) became a `<button>` that opens the lightbox. This also removes the old base64-svg footgun entirely: media only ever renders via `<img>`/`<video>` (script-inert), never a top-level `data:` navigation.                                                                                                                                                                                 |
| `AttachmentRow`         | Adds per-row `viewerOpen` state, the `View` (Eye) button for media rows, and mounts the lightbox.                                                                                                                                                                                                                                                                                                                                                      |

No wire/schema/API changes — this is purely viewer UI over bytes the SW bridge
already serves.

## Verification

- `pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/trace-viewer-attachments-tab.test.tsx`
  — 7 passed, including three new tests: image lightbox via the `View` button
  (blob-URL `<img>` inside the dialog), lightbox via thumbnail click, and
  inline `<video>` playback for a `video/webm` attachment (fixture-built model
  override).
- Full dashboard unit suite: 402 passed / 4 skipped (46 files).
- `pnpm check` — clean (format + lint + type-check) after `check:fix`
  formatting.
