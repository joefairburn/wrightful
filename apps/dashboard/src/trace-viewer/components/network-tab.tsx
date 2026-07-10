"use client";

import { X } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatBytes } from "../format";
import { sha1Path } from "../model";
import type { TraceTabProps } from "../model";
import { useObjectUrl } from "../use-object-url";
import type { TraceBridge } from "../use-trace-model";
import type { Timings } from "../vendor/har";
import type { ResourceEntry } from "../vendor/model-util";

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length
      ? (segments[segments.length - 1] ?? url)
      : parsed.pathname || url;
  } catch {
    return url;
  }
}

/** Response body previews under this size are fetched + rendered as text. */
const TEXT_PREVIEW_MAX_BYTES = 200_000;

/** JSON pretty-print, falling back to the raw text if it doesn't parse. */
function prettyPrint(text: string, mimeType: string): string {
  if (!mimeType.includes("json")) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** HAR timing phases, official-viewer waterfall order. */
const TIMING_PHASES: {
  key: keyof Timings;
  label: string;
  token: string;
}[] = [
  { key: "dns", label: "DNS", token: "bg-chart-1" },
  { key: "connect", label: "Connect", token: "bg-chart-2" },
  { key: "ssl", label: "SSL", token: "bg-chart-3" },
  { key: "send", label: "Send", token: "bg-chart-4" },
  { key: "wait", label: "Wait", token: "bg-chart-5" },
  { key: "receive", label: "Receive", token: "bg-ring" },
];

/** A section of the detail panel: a micro-label header + body. */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2 border-line-1 border-b px-3 py-3 last:border-b-0">
      <h3 className="text-12 font-medium tracking-[0.1px] text-fg-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

function GeneralRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex gap-3 text-13">
      <span className="w-28 shrink-0 text-fg-3">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function GeneralSection({
  entry,
}: {
  entry: ResourceEntry;
}): React.ReactElement {
  const { request, response } = entry;
  // Destructure-and-rename: `_transferSize` is the HAR extension field name
  // (vendor/har.ts); the underscore trips lint as a direct member access.
  const { _transferSize: transferSize } = response;
  return (
    <Section title="General">
      <div className="flex flex-col gap-2">
        <GeneralRow label="URL">
          <span className="break-all font-mono text-12">{request.url}</span>
        </GeneralRow>
        <GeneralRow label="Method">
          <span className="font-mono text-12">{request.method}</span>
        </GeneralRow>
        <GeneralRow label="Status">
          <span
            className={cn(
              "font-mono text-12",
              response.status >= 400 && "text-fail",
            )}
          >
            {response.status || "—"} {response.statusText}
          </span>
        </GeneralRow>
        <GeneralRow label="Remote address">
          {entry.serverIPAddress ?? "—"}
        </GeneralRow>
        <GeneralRow label="Transfer size">
          {typeof transferSize === "number" ? formatBytes(transferSize) : "—"}
        </GeneralRow>
        <GeneralRow label="Content size">
          {formatBytes(response.content.size)}
        </GeneralRow>
        <GeneralRow label="Duration">{Math.round(entry.time)}ms</GeneralRow>
      </div>
    </Section>
  );
}

/** Stacked timing bar + per-phase legend, skipping unset/-1 phases. */
function TimingSection({ timings }: { timings: Timings }): React.ReactElement {
  const phases = TIMING_PHASES.map((phase) => ({
    ...phase,
    value: timings[phase.key],
  })).filter(
    (phase): phase is (typeof TIMING_PHASES)[number] & { value: number } =>
      typeof phase.value === "number" && phase.value >= 0,
  );
  const total = phases.reduce((sum, phase) => sum + phase.value, 0);

  return (
    <Section title="Timing">
      {phases.length === 0 || total <= 0 ? (
        <div className="text-12 text-fg-4">No timing data.</div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-2">
            {phases.map((phase) => (
              <div
                key={phase.key}
                className={phase.token}
                style={{ width: `${(phase.value / total) * 100}%` }}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {phases.map((phase) => (
              <div
                key={phase.key}
                className="flex items-center gap-1.5 text-11 text-fg-3"
              >
                <span
                  className={cn("size-2 shrink-0 rounded-full", phase.token)}
                />
                {phase.label} {phase.value.toFixed(1)}ms
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}

function HeaderRows({
  headers,
}: {
  headers: { name: string; value: string }[];
}): React.ReactElement {
  if (headers.length === 0) {
    return <div className="text-12 text-fg-4">None</div>;
  }
  return (
    <div className="flex flex-col gap-0.5 font-mono text-12">
      {headers.map((header, i) => (
        <div key={`${header.name}-${i}`} className="break-all">
          <span className="text-fg-3">{header.name}: </span>
          <span>{header.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Response body preview: fetched through the bridge by sha1. Images render
 * via `useObjectUrl`; small/text-like bodies are fetched and pretty-printed;
 * everything else falls back to a size note. Extracted so the fetch effect
 * is scoped per-selection instead of living in the parent's render.
 */
function ResponseBodyPreview({
  content,
  traceUrl,
  bridge,
}: {
  content: ResourceEntry["response"]["content"];
  traceUrl: string;
  bridge: TraceBridge;
}): React.ReactElement {
  // Destructure-and-rename: `_sha1` is the HAR extension field name
  // (vendor/har.ts); the underscore trips lint as a direct member access.
  const { _sha1: sha1 } = content;
  const mimeType = content.mimeType.split(";")[0] ?? "";
  const isImage = mimeType.startsWith("image/");
  const isTextLike =
    !isImage &&
    (mimeType.includes("json") ||
      mimeType.includes("text") ||
      mimeType.includes("javascript") ||
      mimeType.includes("css") ||
      mimeType.includes("html") ||
      content.size < TEXT_PREVIEW_MAX_BYTES);

  const path = sha1 ? sha1Path(traceUrl, sha1) : null;
  const { url: imageUrl } = useObjectUrl(bridge, isImage ? path : null);

  const [text, setText] = useState<string | undefined>(undefined);
  const [textError, setTextError] = useState(false);

  useEffect(() => {
    setText(undefined);
    setTextError(false);
    if (isImage || !isTextLike || !path) return;
    let cancelled = false;
    bridge
      .fetchBlob(path)
      .then((blob) => blob.text())
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch(() => {
        if (!cancelled) setTextError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, path, isImage, isTextLike]);

  if (!sha1) {
    return (
      <div className="text-12 text-fg-4">
        Preview not available · {formatBytes(content.size)}
      </div>
    );
  }

  if (isImage) {
    if (!imageUrl) {
      return <div className="text-12 text-fg-4">Loading preview…</div>;
    }
    return (
      <img
        src={imageUrl}
        alt="Response body preview"
        className="max-h-48 rounded border border-line-1 object-contain"
      />
    );
  }

  if (!isTextLike) {
    return (
      <div className="text-12 text-fg-4">
        Preview not available · {formatBytes(content.size)}
      </div>
    );
  }

  if (textError) {
    return <div className="text-12 text-fg-4">Failed to load preview.</div>;
  }
  if (text === undefined) {
    return <div className="text-12 text-fg-4">Loading preview…</div>;
  }

  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-12">
      {prettyPrint(text, mimeType)}
    </pre>
  );
}

function DetailPanel({
  entry,
  traceUrl,
  bridge,
  onClose,
}: {
  entry: ResourceEntry;
  traceUrl: string;
  bridge: TraceBridge;
  onClose: () => void;
}): React.ReactElement {
  const postData = entry.request.postData;
  // Destructure-and-rename: `_sha1` is the HAR extension field name
  // (vendor/har.ts); the underscore trips lint as a direct member access.
  const {
    content: { _sha1: responseSha1 },
  } = entry.response;

  return (
    <div className="flex h-full min-h-0 flex-col border-line-1 border-t sm:border-t-0 sm:border-l">
      <div className="flex shrink-0 items-center gap-2 border-line-1 border-b px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-12"
          title={entry.request.url}
        >
          {entry.request.url}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onClose}
          aria-label="Close request details"
        >
          <X />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col">
          <GeneralSection entry={entry} />
          <TimingSection timings={entry.timings} />
          <Section title="Request headers">
            <HeaderRows headers={entry.request.headers} />
          </Section>
          <Section title="Response headers">
            <HeaderRows headers={entry.response.headers} />
          </Section>
          {postData?.text ? (
            <Section title="Request body">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-12">
                {prettyPrint(postData.text, postData.mimeType)}
              </pre>
            </Section>
          ) : null}
          {responseSha1 ? (
            <Section title="Response body">
              <ResponseBodyPreview
                content={entry.response.content}
                traceUrl={traceUrl}
                bridge={bridge}
              />
            </Section>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * HAR entries as a dense request table, highlighting the selected action's
 * window. Selecting a row splits the tab to show a request detail panel
 * (official-viewer parity: general/timing/headers/bodies).
 */
export function NetworkTab({
  model,
  selectedAction,
  scopeToSelected,
  traceUrl,
  bridge,
}: TraceTabProps): React.ReactElement {
  const scoped = scopeToSelected && selectedAction != null;
  // Scoped: filter to the selected action's window. Unscoped: keep every
  // entry and merely highlight the ones in that window (today's behavior).
  const isWithinSelectedAction = (monotonicTime: number | undefined): boolean =>
    selectedAction != null &&
    monotonicTime != null &&
    monotonicTime >= selectedAction.startTime &&
    monotonicTime <= selectedAction.endTime;
  const entries = scoped
    ? model.resources.filter((entry) =>
        isWithinSelectedAction(entry._monotonicTime),
      )
    : model.resources;

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A freshly loaded trace has an entirely different resource list — drop
  // any stale selection rather than risk it matching an unrelated entry.
  useEffect(() => {
    setSelectedId(null);
  }, [model]);

  // Scoping to the selected action can filter the selected entry out from
  // under it; close the detail panel rather than leave it pointing at a row
  // that's no longer shown.
  useEffect(() => {
    if (
      selectedId != null &&
      !entries.some((entry) => entry.id === selectedId)
    ) {
      setSelectedId(null);
    }
  }, [entries, selectedId]);

  const selectedEntry = entries.find((entry) => entry.id === selectedId);

  if (entries.length === 0) {
    if (scoped) {
      return (
        <div className="px-3 py-4 text-12 text-fg-4">
          No requests during this action.
        </div>
      );
    }
    return (
      <Empty className="h-full py-8">
        <EmptyTitle>No network activity</EmptyTitle>
        <EmptyDescription>
          This trace recorded no network requests.
        </EmptyDescription>
      </Empty>
    );
  }

  const tableArea = (
    <ScrollArea className="h-full">
      <Table stickyHeader>
        <TableHeader className="sticky top-0 z-10 bg-bg-0">
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            // Destructure-and-rename: `_monotonicTime` is the HAR extension
            // field name (vendor/har.ts); the underscore trips lint as a
            // direct member access.
            const { _monotonicTime: monotonicTime } = entry;
            const isHighlighted =
              !scoped && isWithinSelectedAction(monotonicTime);
            const isSelected = entry.id === selectedId;
            const size =
              entry.response.content.size >= 0
                ? entry.response.content.size
                : entry.response.bodySize;
            const mimeType = entry.response.content.mimeType.split(";")[0];
            return (
              <TableRow
                key={entry.id}
                aria-selected={isSelected}
                onClick={() =>
                  setSelectedId((prev) => (prev === entry.id ? null : entry.id))
                }
                className={cn(
                  "cursor-pointer",
                  isSelected ? "bg-bg-3" : isHighlighted && "bg-bg-2",
                )}
              >
                <TableCell
                  className={cn(
                    "font-mono",
                    entry.response.status >= 400 && "text-fail",
                  )}
                >
                  {entry.response.status || "—"}
                </TableCell>
                <TableCell className="font-mono text-fg-3">
                  {entry.request.method}
                </TableCell>
                <TableCell
                  className="max-w-[320px] truncate"
                  title={entry.request.url}
                >
                  {shortUrl(entry.request.url)}
                </TableCell>
                <TableCell className="text-fg-4">{mimeType || "—"}</TableCell>
                <TableCell className="font-mono text-fg-3">
                  {formatBytes(size)}
                </TableCell>
                <TableCell className="font-mono text-fg-3">
                  {Math.round(entry.time)}ms
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );

  if (!selectedEntry) return tableArea;

  return (
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      <div className="min-h-0 min-w-0 shrink-0 grow-0 basis-[55%]">
        {tableArea}
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        <DetailPanel
          entry={selectedEntry}
          traceUrl={traceUrl}
          bridge={bridge}
          onClose={() => setSelectedId(null)}
        />
      </div>
    </div>
  );
}
