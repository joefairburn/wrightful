"use client";

import { useEffect, useRef, useState } from "react";
import type { TraceBridge } from "./use-trace-model";

/**
 * Fetch trace bytes (a `sha1/…` path) through the bridge proxy and expose
 * them as an object URL for `<img>`/`<video>`/download use. Revokes the URL
 * on unmount/path change. `path` may be null to skip (renders nothing yet).
 *
 * Object URLs are per-hook (not globally cached): revocation stays trivially
 * correct, and repeat fetches are cheap — the SW serves sha1 blobs from its
 * in-memory trace, and same-URL requests hit the browser's HTTP cache layer
 * inside the bridge.
 *
 * `opts.keepPrevious` (default off, and byte-for-byte identical to the plain
 * behavior above when off) trades that "revoke on every path change" rule
 * for a flash-free swap: when `path` changes, the hook keeps returning the
 * PREVIOUS resolved object URL — instead of `null` — until the new blob
 * resolves, then swaps to the new URL and revokes the old one. The displayed
 * URL is held in a ref rather than revoked from the per-path effect's own
 * cleanup, so a path change never revokes a URL that's still on screen; a
 * blob that resolves for a path the hook has since moved away from is simply
 * never turned into an object URL (the existing `cancelled` guard), so
 * nothing leaks.
 */
export function useObjectUrl(
  bridge: TraceBridge,
  path: string | null,
  opts?: { keepPrevious?: boolean },
): { url: string | null; error: boolean } {
  const keepPrevious = opts?.keepPrevious ?? false;
  const [result, setResult] = useState<{
    path: string;
    url: string | null;
    error: boolean;
  } | null>(null);

  // keepPrevious only: the object URL currently on screen. Swapped (and the
  // old value revoked) when a replacement resolves; revoked outright on
  // unmount. Not touched in the default mode, which revokes synchronously
  // from the fetch effect's own cleanup instead (see below).
  const displayedUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      // Nothing to fetch. In the default mode this is "renders nothing yet"
      // (clear immediately); keepPrevious has no replacement in flight to
      // hand off to, so it just keeps showing whatever was last displayed.
      if (!keepPrevious) setResult(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    bridge
      .fetchBlob(path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        if (keepPrevious) {
          const previous = displayedUrlRef.current;
          if (previous) URL.revokeObjectURL(previous);
          displayedUrlRef.current = objectUrl;
        }
        setResult({ path, url: objectUrl, error: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ path, url: null, error: true });
      });
    return () => {
      cancelled = true;
      // In keepPrevious mode this URL (if any) is still the displayed one —
      // it's revoked later, by whichever resolves next (swap above) or by
      // the unmount cleanup below, never here.
      if (objectUrl && !keepPrevious) URL.revokeObjectURL(objectUrl);
    };
  }, [bridge, path, keepPrevious]);

  // Unmount-only revocation for keepPrevious mode: the displayed URL has no
  // later "next resolve" to hand cleanup off to once the hook itself goes
  // away, so this is the one place that revokes it.
  useEffect(() => {
    if (!keepPrevious) return;
    return () => {
      if (displayedUrlRef.current) URL.revokeObjectURL(displayedUrlRef.current);
    };
  }, [keepPrevious]);

  if (keepPrevious) {
    return result
      ? { url: result.url, error: result.error }
      : { url: null, error: false };
  }
  return result?.path === path
    ? { url: result.url, error: result.error }
    : { url: null, error: false };
}
