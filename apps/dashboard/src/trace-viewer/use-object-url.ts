"use client";

import { useEffect, useState } from "react";
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
 */
export function useObjectUrl(
  bridge: TraceBridge,
  path: string | null,
): { url: string | null; error: boolean } {
  const [result, setResult] = useState<{
    path: string;
    url: string | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    if (!path) {
      setResult(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    bridge
      .fetchBlob(path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResult({ path, url: objectUrl, error: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ path, url: null, error: true });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bridge, path]);

  return result?.path === path
    ? { url: result.url, error: result.error }
    : { url: null, error: false };
}
