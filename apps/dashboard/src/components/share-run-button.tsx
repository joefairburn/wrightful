"use client";

import { Check, Copy, Share2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { useCopiedFlag } from "@/lib/use-copied-flag";

/**
 * Run-detail header control: mint / copy / revoke a public read-only share
 * link for this run. POSTs to the session-authed
 * `/api/t/:team/p/:project/runs/:id/share` endpoint; the returned `/share/run/`
 * URL renders anonymously. "Revoke" invalidates every active link for the run.
 */
export function ShareRunButton({
  teamSlug,
  projectSlug,
  runId,
}: {
  teamSlug: string;
  projectSlug: string;
  runId: string;
}) {
  const endpoint = `/api/t/${teamSlug}/p/${projectSlug}/runs/${runId}/share`;
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, flash } = useCopiedFlag();

  async function createLink() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { url?: string };
      if (!res.ok || !body.url) throw new Error("mint failed");
      setUrl(body.url);
    } catch {
      setError("Could not create a link. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      if (!res.ok) throw new Error("revoke failed");
      setUrl(null);
    } catch {
      setError("Could not revoke. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    flash();
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="sm" variant="ghost">
            <Share2 />
            Share
          </Button>
        }
      />
      <PopoverPopup align="end" className="flex w-80 flex-col gap-2 p-3">
        <p className="text-[length:var(--text-fs-13)] text-fg-2 leading-relaxed">
          Anyone with the link can view this run's results — no sign-in
          required.
        </p>
        {error && <p className="text-[11px] text-fail">{error}</p>}
        {url ? (
          <>
            <div className="flex items-center gap-2">
              <Input
                className="flex-1 font-mono text-[11px]"
                nativeInput
                onFocus={(e) => e.currentTarget.select()}
                readOnly
                value={url}
              />
              <Button onClick={() => void copy()} size="sm" variant="secondary">
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
            <Button
              disabled={busy}
              onClick={() => void revoke()}
              size="sm"
              variant="ghost"
            >
              Revoke link
            </Button>
          </>
        ) : (
          <Button disabled={busy} onClick={() => void createLink()} size="sm">
            {busy ? "Creating…" : "Create share link"}
          </Button>
        )}
      </PopoverPopup>
    </Popover>
  );
}
