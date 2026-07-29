"use client";

import { snapshotDom } from "./snapshot-dom";
import type { SnapshotDom } from "./snapshot-dom";

/**
 * Close-on-Escape across ALL of a snapshot iframe's same-origin frames.
 * DOM snapshots are SW-rendered same-origin documents that can contain
 * NESTED sub-frames; a keydown while focus is inside any of them reaches
 * neither the parent Dialog nor the snapshot's top window, so Escape would
 * be swallowed. Bind the handler on the given window AND every reachable
 * same-origin descendant frame, re-binding as frames are added or
 * re-navigated during a scrub (each frame's `load` + a `MutationObserver`
 * per document). Every access is guarded and realm-safe (`snapshotDom`) — a
 * cross-origin frame is skipped, a snapshot that shadows `querySelectorAll` /
 * `documentElement` with named elements cannot throw out of here, and any
 * failure degrades to the Dialog's own Escape/backdrop handling. That matters
 * beyond Escape itself: this runs first in the snapshot iframe's `onLoad`, so a
 * throw here would also skip the back-buffer promotion and the script-less
 * visibility fixup that follow it. Idempotent, keyed on `Document` rather than
 * `Window`: a frame's
 * `contentWindow` is a stable WindowProxy across same-origin navigations,
 * but `keydown` listeners live on the per-navigation inner window/document —
 * keying the guard on the window would silently stop re-binding after a
 * nested frame's first navigation. `win.document` gives a fresh object per
 * navigation, so a re-navigated frame gets a fresh listener. The returned
 * cleanup tears everything down.
 *
 * (Moved verbatim from trace-viewer-dialog.tsx, where it used to guard the
 * old full-viewer iframe.)
 */
export function bindEscapeAcrossFrames(
  topWin: Window,
  onEscape: () => void,
): () => void {
  const cleanups: Array<() => void> = [];
  const boundDocs = new WeakSet<Document>();
  const boundFrames = new WeakSet<Element>();
  const observedDocs = new WeakSet<Document>();

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") onEscape();
  };

  function bindWindow(win: Window): void {
    const dom = snapshotDom(win);
    if (!dom) return; // cross-origin frame — unreachable, skip
    if (boundDocs.has(dom.document)) return;
    boundDocs.add(dom.document);
    try {
      // Plain access is fine at WINDOW scope, unlike on the document: a global's
      // own interface members win over its named-property object, so an
      // `<iframe name="addEventListener">` in the snapshot cannot shadow this
      // (measured in Chromium). Only document/element reads need `dom`.
      win.addEventListener("keydown", onKey);
    } catch {
      return; // window already torn down mid-access
    }
    cleanups.push(() => {
      try {
        win.removeEventListener("keydown", onKey);
      } catch {
        /* window already torn down */
      }
    });
    scanDoc(dom);
  }

  function scanDoc(dom: SnapshotDom): void {
    // Every read below goes through `dom`, not the document, because a snapshot
    // is attacker-craftable and `Document` has [LegacyOverrideBuiltIns] — an
    // `<img name="querySelectorAll">` would otherwise throw a TypeError here,
    // and `<img name="documentElement">` would silently redirect the observer
    // onto an attacker-chosen element. Measured in Chromium; see snapshot-dom.ts.
    for (const frame of dom.queryAll("iframe")) {
      if (boundFrames.has(frame)) continue;
      boundFrames.add(frame);
      const onFrameLoad = (): void => {
        const cw = (frame as HTMLIFrameElement).contentWindow;
        if (cw) bindWindow(cw);
      };
      frame.addEventListener("load", onFrameLoad);
      cleanups.push(() => frame.removeEventListener("load", onFrameLoad));
      onFrameLoad(); // bind whatever's currently loaded
    }
    if (observedDocs.has(dom.document)) return;
    const root = dom.documentElement();
    if (!root) return; // nothing to observe (never happens for a parsed document)
    observedDocs.add(dom.document);
    const observer = new MutationObserver(() => scanDoc(dom));
    observer.observe(root, { childList: true, subtree: true });
    cleanups.push(() => observer.disconnect());
  }

  bindWindow(topWin);
  return () => {
    for (const c of cleanups) c();
  };
}
