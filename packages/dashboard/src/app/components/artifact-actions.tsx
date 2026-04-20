"use client";

import { Copy, CopyCheck, History, ImageIcon, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/app/components/ui/dialog";
import { cn } from "@/lib/cn";

export interface ArtifactAction {
  id: string;
  type: string;
  name: string;
  contentType: string;
  downloadHref: string;
  /** Present only for type === "trace". */
  traceViewerUrl?: string;
}

export function ArtifactActions({
  artifacts,
}: {
  artifacts: ArtifactAction[];
}): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-2">
      {artifacts.map((a) => (
        <ArtifactButton key={a.id} artifact={a} />
      ))}
    </div>
  );
}

function ArtifactButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  switch (artifact.type) {
    case "video":
      return <VideoButton artifact={artifact} />;
    case "screenshot":
      return <ScreenshotButton artifact={artifact} />;
    case "trace":
      return <TraceButton artifact={artifact} />;
    default:
      return <CopyPromptButton artifact={artifact} />;
  }
}

export { CopyPromptButton };

function VideoButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  return (
    <Dialog>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>
        <Play />
        Play video
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogTitle className="sr-only">Video: {artifact.name}</DialogTitle>
        <video
          className="w-full rounded-b-2xl bg-black"
          controls
          autoPlay
          src={artifact.downloadHref}
        >
          <track kind="captions" />
        </video>
      </DialogContent>
    </Dialog>
  );
}

function ScreenshotButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  return (
    <Dialog>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>
        <ImageIcon />
        View screenshot
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
        <DialogTitle className="sr-only">
          Screenshot: {artifact.name}
        </DialogTitle>
        <img
          className="w-full rounded-b-2xl bg-muted"
          alt={artifact.name}
          src={artifact.downloadHref}
        />
      </DialogContent>
    </Dialog>
  );
}

function TraceButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  if (!artifact.traceViewerUrl) return <></>;
  return (
    <Button
      size="xs"
      variant="outline"
      render={
        <a href={artifact.traceViewerUrl} target="_blank" rel="noreferrer" />
      }
    >
      <History />
      Open trace
    </Button>
  );
}

function CopyPromptButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onCopy(): Promise<void> {
    setLoading(true);
    try {
      const res = await fetch(artifact.downloadHref);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silent — button returns to idle. A toast could be layered on later.
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() => {
        void onCopy();
      }}
      loading={loading}
      className={cn(copied && "text-foreground")}
    >
      {copied ? <CopyCheck /> : <Copy />}
      {copied ? "Copied" : "Copy prompt"}
    </Button>
  );
}
