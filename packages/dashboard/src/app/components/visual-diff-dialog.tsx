"use client";

import { ArrowRight, ImageOff, SplitSquareHorizontal } from "lucide-react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import type React from "react";
import type {
  ArtifactAction,
  VisualDiffFrame,
  VisualDiffGroup,
} from "@/app/components/artifact-actions";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/app/components/ui/dialog";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/app/components/ui/tabs";
import { cn } from "@/lib/cn";

const MODES = ["diff", "expected", "actual", "side-by-side"] as const;
type Mode = (typeof MODES)[number];

/**
 * Trigger + dialog for one Playwright visual snapshot triple
 * (`expected`/`actual`/`diff`). Rail-styled button matches the screenshot /
 * video / trace siblings; the modal mirrors Playwright's HTML reporter
 * layout — three single-image tabs plus a side-by-side comparison.
 *
 * The mode is persisted in `?vmode=` so deep-links to a specific viewing
 * mode work and so the user's preference is sticky across multiple visual
 * diffs in the same test detail page.
 */
export function VisualDiffRailButton({
  artifact,
}: {
  artifact: ArtifactAction;
}): React.ReactElement {
  const group = artifact.visualGroup;
  if (!group) return <></>;
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-between"
          />
        }
      >
        <span className="inline-flex items-center gap-2">
          <SplitSquareHorizontal />
          Visual diff
          <span className="text-muted-foreground text-xs">
            {group.snapshotName}
          </span>
        </span>
        <ArrowRight className="opacity-50" aria-hidden />
      </DialogTrigger>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle className="font-mono text-sm">
              {group.snapshotName}
            </DialogTitle>
            <Badge variant="error" size="sm">
              Visual diff failed
            </Badge>
          </div>
        </DialogHeader>
        <VisualDiffViewer group={group} />
      </DialogContent>
    </Dialog>
  );
}

export function VisualDiffViewer({
  group,
}: {
  group: VisualDiffGroup;
}): React.ReactElement {
  const [mode, setMode] = useQueryState(
    "vmode",
    parseAsStringLiteral(MODES).withDefault("diff"),
  );
  const tabValues = MODES.filter((m) => {
    if (m === "side-by-side") return Boolean(group.expected && group.actual);
    return Boolean(group[m]);
  });
  // If the active mode's frame is missing (e.g. URL hand-typed `vmode=diff`
  // for a triple that lost its diff frame), drop back to the first available
  // tab without persisting the change — the user can still pick another.
  const activeMode = tabValues.includes(mode) ? mode : (tabValues[0] ?? "diff");

  return (
    <Tabs
      value={activeMode}
      onValueChange={(v) => {
        void setMode(v as Mode);
      }}
      className="px-6 pb-6 gap-4"
    >
      <TabsList variant="underline" className="self-start">
        {tabValues.map((m) => (
          <TabsTab key={m} value={m}>
            {labelFor(m)}
          </TabsTab>
        ))}
      </TabsList>
      {tabValues.includes("diff") ? (
        <TabsPanel value="diff">
          <FrameImage
            frame={group.diff}
            alt={`Diff for ${group.snapshotName}`}
          />
        </TabsPanel>
      ) : null}
      {tabValues.includes("expected") ? (
        <TabsPanel value="expected">
          <FrameImage
            frame={group.expected}
            alt={`Expected baseline for ${group.snapshotName}`}
          />
        </TabsPanel>
      ) : null}
      {tabValues.includes("actual") ? (
        <TabsPanel value="actual">
          <FrameImage
            frame={group.actual}
            alt={`Actual capture for ${group.snapshotName}`}
          />
        </TabsPanel>
      ) : null}
      {tabValues.includes("side-by-side") ? (
        <TabsPanel value="side-by-side">
          <div className="grid grid-cols-2 gap-2">
            <SideBySideFrame
              label="Expected"
              frame={group.expected}
              alt={`Expected baseline for ${group.snapshotName}`}
            />
            <SideBySideFrame
              label="Actual"
              frame={group.actual}
              alt={`Actual capture for ${group.snapshotName}`}
            />
          </div>
        </TabsPanel>
      ) : null}
    </Tabs>
  );
}

function labelFor(m: Mode): string {
  if (m === "side-by-side") return "Side-by-side";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function FrameImage({
  frame,
  alt,
}: {
  frame: VisualDiffFrame | null;
  alt: string;
}): React.ReactElement {
  if (!frame) return <FrameMissing />;
  return (
    <img className="w-full rounded-md bg-muted" alt={alt} src={frame.href} />
  );
}

function SideBySideFrame({
  label,
  frame,
  alt,
}: {
  label: string;
  frame: VisualDiffFrame | null;
  alt: string;
}): React.ReactElement {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </figcaption>
      {frame ? (
        <img
          className={cn("w-full rounded-md bg-muted")}
          alt={alt}
          src={frame.href}
        />
      ) : (
        <FrameMissing />
      )}
    </figure>
  );
}

function FrameMissing(): React.ReactElement {
  return (
    <div className="flex aspect-video w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 text-muted-foreground text-sm">
      <ImageOff className="size-4" aria-hidden />
      Not available
    </div>
  );
}
