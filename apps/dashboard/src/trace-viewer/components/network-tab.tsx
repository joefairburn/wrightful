"use client";

import { ChevronDown, ChevronUp, X } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
import { SearchFilterInput } from "@/components/search-filter-input";
import { SegmentedControl } from "@/components/segmented-control";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatBytes, formatTraceDuration, prettyPrintJson } from "../format";
import {
  contentSha1,
  harResourceType,
  monotonicTime,
  transferSize,
  webSocketMessages,
} from "../har-fields";
import { baseMimeType } from "../mime";
import { timeInRange, type TraceTimeRange } from "../model";
import type { TraceTabProps } from "../model";
import type { TraceBridge } from "../use-trace-model";
import type { Timings } from "../vendor/har";
import type { ResourceEntry } from "../vendor/model-util";
import { BridgeBodyPreview } from "./body-preview";
import { GeneralRow, ScopedEmpty, Section, TabNotice } from "./detail-shared";

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

type ResourceTypeFilter =
  | "all"
  | "fetch"
  | "html"
  | "js"
  | "css"
  | "font"
  | "image"
  | "ws";

const RESOURCE_TYPE_OPTIONS: {
  value: ResourceTypeFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "fetch", label: "Fetch" },
  { value: "html", label: "HTML" },
  { value: "js", label: "JS" },
  { value: "css", label: "CSS" },
  { value: "font", label: "Font" },
  { value: "image", label: "Image" },
  { value: "ws", label: "WS" },
];

/**
 * DevTools-style request category. The browser-reported `_resourceType` is
 * authoritative when present (a fetch that happens to return HTML is still
 * "Fetch"); traces without it fall back to the response mime type. Entries
 * matching no category only show under "All".
 */
function resourceTypeOf(entry: ResourceEntry): ResourceTypeFilter | null {
  if (webSocketMessages(entry)) return "ws";
  switch (harResourceType(entry)) {
    case "websocket":
      return "ws";
    case "fetch":
    case "xhr":
    case "eventsource":
      return "fetch";
    case "document":
      return "html";
    case "script":
      return "js";
    case "stylesheet":
      return "css";
    case "font":
      return "font";
    case "image":
      return "image";
    default:
      break;
  }
  const mimeType = entry.response.content.mimeType;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.includes("javascript") || mimeType.includes("ecmascript")) {
    return "js";
  }
  if (mimeType.includes("css")) return "css";
  if (mimeType.includes("font")) return "font";
  if (mimeType.includes("html")) return "html";
  if (mimeType.includes("json")) return "fetch";
  return null;
}

/** The Size column's value: content size when captured, else the wire body size. */
function entrySize(entry: ResourceEntry): number {
  return entry.response.content.size >= 0
    ? entry.response.content.size
    : entry.response.bodySize;
}

/** The Type column's value: response mime type without parameters. */
function entryMimeType(entry: ResourceEntry): string {
  return baseMimeType(entry.response.content.mimeType);
}

/**
 * Network entries visible for a timeline `selection` (by request start time,
 * before the crosshair's action-window scoping). The single source of truth
 * for both the tab body and `DetailTabs`' tab-label count, so the badge can't
 * disagree with the list.
 */
export function selectNetworkEntries(
  model: TraceTabProps["model"],
  selection: TraceTimeRange | null,
): ResourceEntry[] {
  return selection
    ? model.resources.filter((entry) =>
        timeInRange(monotonicTime(entry), selection),
      )
    : model.resources;
}

type SortKey = "status" | "method" | "name" | "type" | "size" | "duration";
type SortState = { key: SortKey; dir: "asc" | "desc" };

/** Per-column sort values — each matches what the column displays. */
const SORT_ACCESSORS: Record<
  SortKey,
  (entry: ResourceEntry) => string | number
> = {
  status: (entry) => entry.response.status,
  method: (entry) => entry.request.method,
  name: (entry) => shortUrl(entry.request.url).toLowerCase(),
  type: (entry) => entryMimeType(entry),
  size: (entry) => entrySize(entry),
  duration: (entry) => entry.time,
};

function compareEntries(
  a: ResourceEntry,
  b: ResourceEntry,
  sort: SortState,
): number {
  const av = SORT_ACCESSORS[sort.key](a);
  const bv = SORT_ACCESSORS[sort.key](b);
  const cmp =
    typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av).localeCompare(String(bv));
  return sort.dir === "asc" ? cmp : -cmp;
}

/**
 * Header cell that cycles its column's sort on click: ascending →
 * descending → back to the trace's natural (request-start) order. The icon
 * slot is always rendered so the column doesn't shift when sorting engages.
 */
function SortableHead({
  label,
  sortKey,
  sort,
  onToggle,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState | null;
  onToggle: (key: SortKey) => void;
}): React.ReactElement {
  const dir = sort?.key === sortKey ? sort.dir : null;
  return (
    <TableHead
      aria-sort={
        dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined
      }
      // The cell's padding moves onto the full-bleed button so the whole
      // header — not just the label text — is the click target.
      className="p-0"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => onToggle(sortKey)}
              // Inset ring: the button is full-bleed inside a sticky header
              // row, so an outward ring/outline would clip against the
              // neighboring cells.
              className="flex size-full items-center gap-0.5 px-2.5 outline-none hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              {label}
              <span aria-hidden className="inline-flex size-3 items-center">
                {dir === "asc" ? (
                  <ChevronUp className="size-3" />
                ) : dir === "desc" ? (
                  <ChevronDown className="size-3" />
                ) : null}
              </span>
            </button>
          }
        />
        <TooltipPopup>Sort by {label.toLowerCase()}</TooltipPopup>
      </Tooltip>
    </TableHead>
  );
}

/** Links each row's disclosure button (`aria-controls`) to the detail panel. */
const DETAIL_PANEL_ID = "trace-network-request-details";

/** This tab's `Section` wrapper: bordered/padded rows, official-viewer parity. */
const NETWORK_SECTION_CLASSES =
  "flex flex-col gap-2 border-line-1 border-b px-3 py-3 last:border-b-0";

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

function GeneralSection({
  entry,
}: {
  entry: ResourceEntry;
}): React.ReactElement {
  const { request, response } = entry;
  const transfer = transferSize(response);
  return (
    <Section title="General" className={NETWORK_SECTION_CLASSES}>
      <div className="flex flex-col gap-2">
        <GeneralRow label="URL">
          <span className="break-all font-mono text-caption">
            {request.url}
          </span>
        </GeneralRow>
        <GeneralRow label="Method">
          <span className="font-mono text-caption">{request.method}</span>
        </GeneralRow>
        <GeneralRow label="Status">
          <span
            className={cn(
              "font-mono text-caption",
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
          {typeof transfer === "number" ? formatBytes(transfer) : "—"}
        </GeneralRow>
        <GeneralRow label="Content size">
          {formatBytes(response.content.size)}
        </GeneralRow>
        <GeneralRow label="Duration">
          {formatTraceDuration(entry.time)}
        </GeneralRow>
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
    <Section title="Timing" className={NETWORK_SECTION_CLASSES}>
      {phases.length === 0 || total <= 0 ? (
        <div className="text-caption text-fg-4">No timing data.</div>
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
                className="flex items-center gap-1.5 text-micro text-fg-3"
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
    return <div className="text-caption text-fg-4">None</div>;
  }
  return (
    <div className="flex flex-col gap-0.5 font-mono text-caption">
      {headers.map((header, i) => (
        <div key={`${header.name}-${i}`} className="break-all">
          <span className="text-fg-3">{header.name}: </span>
          <span>{header.value}</span>
        </div>
      ))}
    </div>
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
  const responseSha1 = contentSha1(entry.response.content);

  return (
    <div
      id={DETAIL_PANEL_ID}
      className="flex h-full min-h-0 flex-col border-line-1 border-t sm:border-t-0 sm:border-l"
    >
      <div className="flex shrink-0 items-center gap-2 border-line-1 border-b px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-caption"
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
          <Section title="Request headers" className={NETWORK_SECTION_CLASSES}>
            <HeaderRows headers={entry.request.headers} />
          </Section>
          <Section title="Response headers" className={NETWORK_SECTION_CLASSES}>
            <HeaderRows headers={entry.response.headers} />
          </Section>
          {postData?.text ? (
            <Section title="Request body" className={NETWORK_SECTION_CLASSES}>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-caption">
                {prettyPrintJson(postData.text, postData.mimeType)}
              </pre>
            </Section>
          ) : null}
          {responseSha1 ? (
            <Section title="Response body" className={NETWORK_SECTION_CLASSES}>
              <BridgeBodyPreview
                sha1={responseSha1}
                mimeType={entry.response.content.mimeType}
                size={entry.response.content.size}
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
 * window. A toolbar filters by URL substring and DevTools-style resource
 * type. Selecting a row splits the tab to show a request detail panel
 * (official-viewer parity: general/timing/headers/bodies).
 */
export function NetworkTab({
  model,
  selectedAction,
  scopeToSelected,
  selection,
  traceUrl,
  bridge,
}: TraceTabProps): React.ReactElement {
  const scoped = scopeToSelected && selectedAction != null;
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ResourceTypeFilter>("all");
  const [sort, setSort] = useState<SortState | null>(null);
  const toggleSort = (key: SortKey): void =>
    setSort((prev) =>
      prev?.key !== key
        ? { key, dir: "asc" }
        : prev.dir === "asc"
          ? { key, dir: "desc" }
          : null,
    );
  // A timeline selection narrows the entry universe first (by request start
  // time); the crosshair's action-window scoping then applies within it.
  const allEntries = selectNetworkEntries(model, selection);
  // The selected action's window as a range — the timeline-selection filter
  // above and the action-window scoping/highlighting here share one
  // `timeInRange` predicate. Scoped: filter to it. Unscoped: keep every entry
  // and merely highlight the ones inside it (below).
  const actionRange: TraceTimeRange | null = selectedAction
    ? { start: selectedAction.startTime, end: selectedAction.endTime }
    : null;
  const scopedEntries =
    scoped && actionRange
      ? allEntries.filter((entry) =>
          timeInRange(monotonicTime(entry), actionRange),
        )
      : allEntries;

  const needle = query.trim().toLowerCase();
  const filtered = scopedEntries.filter(
    (entry) =>
      (typeFilter === "all" || resourceTypeOf(entry) === typeFilter) &&
      (needle === "" || entry.request.url.toLowerCase().includes(needle)),
  );
  // Unsorted = the trace's natural request-start order.
  const entries = sort
    ? [...filtered].sort((a, b) => compareEntries(a, b, sort))
    : filtered;

  // Model identity is fixed for the lifetime of a mount (the parent
  // Workbench remounts per trace via `key={traceUrl}`), so no reset-on-model
  // effect is needed here. A scoped-out or filtered-out selection simply
  // isn't found below (`selectedEntry` is undefined) and the detail panel
  // hides — it reappears if the scope/filter is relaxed again.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedEntry = entries.find((entry) => entry.id === selectedId);
  // The selected row's disclosure button — closing the panel via its X would
  // otherwise drop keyboard focus on an unmounted element.
  const selectedRowButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeDetailPanel = (): void => {
    setSelectedId(null);
    selectedRowButtonRef.current?.focus();
  };

  if (scopedEntries.length === 0) {
    return (
      <ScopedEmpty
        scoped={scoped || selection !== null}
        scopedMessage={
          scoped
            ? "No requests during this action."
            : "No requests in the selected timeline range."
        }
        title="No network activity"
        description="This trace recorded no network requests."
      />
    );
  }

  const toolbar = (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line-1 px-2 py-1.5">
      <SearchFilterInput
        placeholder="Filter requests"
        aria-label="Filter requests"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="min-w-40 flex-1"
      />
      <SegmentedControl
        compact
        value={typeFilter}
        onChange={setTypeFilter}
        options={RESOURCE_TYPE_OPTIONS}
      />
    </div>
  );

  const tableArea = (
    <ScrollArea className="h-full">
      <Table stickyHeader>
        <TableHeader className="sticky top-0 z-10 bg-bg-0">
          <TableRow>
            <SortableHead
              label="Name"
              sortKey="name"
              sort={sort}
              onToggle={toggleSort}
            />
            <SortableHead
              label="Status"
              sortKey="status"
              sort={sort}
              onToggle={toggleSort}
            />
            <SortableHead
              label="Method"
              sortKey="method"
              sort={sort}
              onToggle={toggleSort}
            />
            <SortableHead
              label="Type"
              sortKey="type"
              sort={sort}
              onToggle={toggleSort}
            />
            <SortableHead
              label="Size"
              sortKey="size"
              sort={sort}
              onToggle={toggleSort}
            />
            <SortableHead
              label="Duration"
              sortKey="duration"
              sort={sort}
              onToggle={toggleSort}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            const isHighlighted =
              !scoped &&
              actionRange != null &&
              timeInRange(monotonicTime(entry), actionRange);
            const isSelected = entry.id === selectedId;
            return (
              <TableRow
                key={entry.id}
                className={cn(
                  isSelected ? "bg-bg-3" : isHighlighted && "bg-bg-2",
                )}
              >
                <TableCell className="max-w-[320px]">
                  {/* Stretched disclosure button (the RowLink pattern, but a
                      button): its after-pseudo fills the `relative` TableRow,
                      so the whole row toggles the detail panel while keyboard
                      focus, the accessible name, and the expanded state live
                      on a real control. */}
                  <button
                    type="button"
                    ref={isSelected ? selectedRowButtonRef : undefined}
                    onClick={() =>
                      setSelectedId((prev) =>
                        prev === entry.id ? null : entry.id,
                      )
                    }
                    aria-expanded={isSelected}
                    aria-controls={isSelected ? DETAIL_PANEL_ID : undefined}
                    title={entry.request.url}
                    className="block w-full truncate text-left focus-visible:outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                  >
                    {shortUrl(entry.request.url)}
                  </button>
                </TableCell>
                <TableCell
                  data-status={entry.response.status >= 400 ? "fail" : "ok"}
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
                <TableCell className="text-fg-4">
                  {entryMimeType(entry) || "—"}
                </TableCell>
                <TableCell className="font-mono text-fg-3">
                  {formatBytes(entrySize(entry))}
                </TableCell>
                <TableCell className="font-mono text-fg-3">
                  {formatTraceDuration(entry.time)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );

  const content =
    entries.length === 0 ? (
      // Filters excluded everything — keep the toolbar visible (unlike the
      // no-requests-at-all early return above) so they can be cleared.
      <TabNotice>No matching requests.</TabNotice>
    ) : (
      // One stable wrapper whether or not the detail panel is open — swapping
      // the structure would remount the table, which resets its scroll
      // position and detaches the focused row button mid-interaction.
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <div
          className={cn(
            "min-h-0 min-w-0",
            selectedEntry ? "shrink-0 grow-0 basis-[55%]" : "flex-1",
          )}
        >
          {tableArea}
        </div>
        {selectedEntry ? (
          <div className="min-h-0 min-w-0 flex-1">
            <DetailPanel
              entry={selectedEntry}
              traceUrl={traceUrl}
              bridge={bridge}
              onClose={closeDetailPanel}
            />
          </div>
        ) : null}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
}
