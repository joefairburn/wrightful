"use client";

/**
 * Realm-safe DOM access for snapshot documents.
 *
 * A DOM snapshot is reconstructed from **attacker-craftable** trace bytes (any
 * project ingest-key holder can upload an arbitrary trace), and `Document` has
 * `[LegacyOverrideBuiltIns]`: a named element in the captured page shadows the
 * real interface member. Playwright's serializer strips `<script>` and `on*`
 * attributes but leaves `name` alone, so `<img name="querySelectorAll">`
 * survives into the rendered snapshot — and then the obvious
 * `doc.querySelectorAll(…)` throws `TypeError: not a function`.
 *
 * Measured in Chromium against a real `sandbox="allow-same-origin"` frame:
 * `querySelector`, `querySelectorAll`, `addEventListener` and `documentElement`
 * all clobber this way (the last one silently yields an attacker-chosen element
 * rather than throwing). The frame's own `Window` interface objects —
 * `win.Document`, `win.EventTarget` — do **not**, because a global's own
 * properties win over its named-property object. So resolve the methods through
 * those prototypes once, then call them on the document.
 *
 * Everything the parent frame does to a snapshot goes through here, so the
 * hostile-input reasoning lives in one place rather than being re-derived at
 * each call site.
 */

type SnapshotRealm = Window & {
  readonly Document: typeof Document;
  readonly EventTarget: typeof EventTarget;
};

/** Realm-safe handle on one snapshot frame's document. */
export type SnapshotDom = {
  readonly window: Window;
  readonly document: Document;
  /** First match, resolved through the realm's `Document.prototype`. */
  query(selectors: string): Element | null;
  /** All matches, as a snapshot array (safe to mutate the DOM while iterating). */
  queryAll(selectors: string): Element[];
  /** The document element, reached via `:root` rather than the clobberable getter. */
  documentElement(): Element | null;
  /** Add a listener without trusting the target's own `addEventListener`. */
  listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    capture?: boolean,
  ): void;
};

/**
 * Open a realm-safe handle on `win`'s document, or `null` when the frame is
 * unreachable: cross-origin (a snapshot that navigated itself makes
 * `win.document` throw `SecurityError` on the next `load`) or torn down
 * mid-access. One guarded entry point, so callers stop guarding each access.
 */
export function snapshotDom(win: Window): SnapshotDom | null {
  try {
    const realm = win as SnapshotRealm;
    const document = realm.document;
    // Hold the prototypes, not the methods: every use below immediately `.call`s
    // through the member expression, so `this` is always supplied explicitly.
    const docProto = realm.Document.prototype;
    const eventTargetProto = realm.EventTarget.prototype;
    return {
      window: win,
      document,
      query: (selectors) => docProto.querySelector.call(document, selectors),
      queryAll: (selectors) =>
        Array.from(docProto.querySelectorAll.call(document, selectors)),
      documentElement: () => docProto.querySelector.call(document, ":root"),
      listen: (target, type, listener, capture = false) => {
        eventTargetProto.addEventListener.call(target, type, listener, capture);
      },
    };
  } catch {
    return null;
  }
}
