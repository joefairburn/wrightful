"use client";

/**
 * Exact contents of the guard `<style>` Playwright prepends to every rendered
 * DOM snapshot. Kept as a literal (not a pattern) so a Playwright upgrade that
 * changes it fails the drift canary in `trace-viewer-vendor.test.ts` instead of
 * silently regressing replay to a blank pane.
 */
export const SNAPSHOT_VISIBILITY_GUARD_CSS =
  "*,*::before,*::after { visibility: hidden }";

/**
 * A snapshot frame's own realm. Every DOM call below goes through these
 * constructors' prototypes rather than through the document, because a
 * snapshot document is reconstructed from attacker-craftable trace bytes and
 * `Document` has `[LegacyOverrideBuiltIns]`: an `<img name="querySelector">`
 * or `<img name="addEventListener">` in the captured page shadows the real
 * method, so `doc.querySelector(...)` throws `TypeError: not a function`.
 * Named properties cannot shadow a global's own interface objects, so
 * `win.Document` / `win.EventTarget` stay trustworthy.
 */
type SnapshotRealm = Window & {
  readonly Document: typeof Document;
  readonly EventTarget: typeof EventTarget;
};

/** Named, not inline, so a repeated `load` registers one listener rather than N. */
function suppressNavigation(event: Event): void {
  event.preventDefault();
}

/**
 * Apply the two fixups a snapshot rendered WITHOUT scripts needs, and only
 * those two.
 *
 * Every snapshot document Playwright's service worker renders starts with
 * `<style>*,*::before,*::after { visibility: hidden }</style>` followed by an
 * inline bootstrap script. The guard hides the whole document so the raw
 * serialized DOM never flashes before the script has applied its fixups; the
 * bootstrap then disables that first stylesheet and suppresses clicks on every
 * `<a>` — the serializer rewrites `src` but deliberately leaves `href` alone,
 * so the anchors in a snapshot still point at their original live URLs.
 *
 * On the same-origin default the snapshot iframe is sandboxed WITHOUT
 * `allow-scripts` (see `snapshotSandbox` — uploaded trace bytes are
 * attacker-craftable, so nothing from a snapshot may execute under the session
 * origin). That is intentional, but it also means the bootstrap never runs, so
 * the guard is never lifted and the pane renders a blank white frame — not the
 * "static DOM still renders" the isolation trade-off is documented to cost.
 *
 * So do what the blocked script would have done for visibility, plus the one
 * thing that visibility makes newly reachable:
 *
 * 1. Suppress navigation. `visibility: hidden` is not hit-testable, so while
 *    the guard is up there is nothing to click; lifting it makes the captured
 *    page's links live. A capturing document listener covers both a pointer
 *    click and Enter on a focused link (which dispatches a synthetic click).
 *    Without it, one click replaces the replay with a real page load inside
 *    the pane — the frame is keyed by URL, so React never remounts it and the
 *    snapshot is unrecoverable until the user scrubs away and back.
 * 2. Lift the guard, matching only the FIRST `<style>` in the document and only
 *    on an exact text match — the same "it is `styleSheets[0]`" assumption
 *    Playwright's own bootstrap makes. A snapshot whose head does not open with
 *    the guard keeps its stylesheet.
 *
 * Everything else the bootstrap would have restored stays unrestored — that IS
 * the documented fidelity cost of running same-origin (see the trace-viewer
 * origin isolation section in SELF-HOSTING.md). Deliberately NOT done: `inert`
 * on the frame would neutralise clicks too, but it also blocks scrolling into
 * the frame (measured), and scrolling is the only way left to see below the
 * fold once scroll restoration is gone.
 *
 * Never throws. The whole reach-in is guarded because a snapshot frame that
 * navigated itself is cross-origin (reading `win.document` throws
 * `SecurityError`) and because the document is hostile input; callers run this
 * from an `onLoad` handler that has its own bookkeeping to finish.
 */
export function prepareScriptlessSnapshot(win: Window): void {
  try {
    const realm = win as SnapshotRealm;
    const doc = realm.document;

    realm.EventTarget.prototype.addEventListener.call(
      doc,
      "click",
      suppressNavigation,
      true,
    );

    const guard = realm.Document.prototype.querySelector.call(doc, "style");
    if (guard?.textContent !== SNAPSHOT_VISIBILITY_GUARD_CSS) return;
    guard.remove();
  } catch {
    // Cross-origin frame, or a document we cannot read. Nothing to reveal, and
    // never the caller's problem.
  }
}
