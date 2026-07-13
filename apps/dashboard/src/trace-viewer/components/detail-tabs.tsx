"use client";

import { Crosshair } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { formatTraceOffset } from "../format";
import type { TraceTabProps } from "../model";
import type { TraceBridge } from "../use-trace-model";
import { AttachmentsTab } from "./attachments-tab";
import { CallTab } from "./call-tab";
import { ConsoleTab, isConsoleRow } from "./console-tab";
import { TabNotice } from "./detail-shared";
import { ErrorsTab } from "./errors-tab";
import { MetadataTab } from "./metadata-tab";
import { NetworkTab } from "./network-tab";
import { SourceTab } from "./source-tab";

type DetailTabId =
  | "call"
  | "log"
  | "errors"
  | "console"
  | "network"
  | "source"
  | "attachments"
  | "metadata";

/**
 * Bottom pane: cross-cutting trace details. Counts on the tab labels are
 * whole-trace; the Log tab is scoped to the selected action; Console/Network
 * can optionally FILTER to the selected action's window (the crosshair
 * toggle) instead of only highlighting it.
 */
export function DetailTabs({
  model,
  selectedAction,
  onSelectAction,
  traceUrl,
  bridge,
}: {
  model: TraceTabProps["model"];
  selectedAction: TraceTabProps["selectedAction"];
  onSelectAction: TraceTabProps["onSelectAction"];
  traceUrl: string;
  bridge: TraceBridge;
}): React.ReactElement {
  const errorCount = model.errorDescriptors.length;
  const consoleCount = model.events.filter(isConsoleRow).length;
  const [tab, setTab] = useState<DetailTabId>(
    errorCount > 0 ? "errors" : "call",
  );
  const [scopeToSelected, setScopeToSelected] = useState(false);

  const tabProps: TraceTabProps = {
    model,
    selectedAction,
    onSelectAction,
    traceUrl,
    bridge,
    scopeToSelected,
  };

  const tabs: Array<{ id: DetailTabId; label: string; count?: number }> = [
    { id: "call", label: "Call" },
    { id: "log", label: "Log" },
    { id: "errors", label: "Errors", count: errorCount },
    { id: "console", label: "Console", count: consoleCount },
    { id: "network", label: "Network", count: model.resources.length },
    ...(model.hasSource ? [{ id: "source" as const, label: "Source" }] : []),
    {
      id: "attachments",
      label: "Attachments",
      count: model.visibleAttachments.length,
    },
    { id: "metadata", label: "Metadata" },
  ];

  // The workbench stays mounted across an attempt swap, so `tab` survives into
  // the new model. A tab can disappear from the list (Source drops when the new
  // attempt recorded no source) — fall back to the first tab so the body never
  // renders a pane whose tab is no longer selectable.
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const scopable = activeTab === "console" || activeTab === "network";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-end justify-between gap-2 pr-2">
        <TabBar className="min-w-0 flex-1 px-2" role="tablist">
          {tabs.map(({ id, label, count }) => (
            <TabBarTab
              key={id}
              active={activeTab === id}
              onSelect={() => setTab(id)}
            >
              {label}
              {count ? (
                <span className="ml-1 text-micro text-fg-4 tabular-nums">
                  {count}
                </span>
              ) : null}
            </TabBarTab>
          ))}
        </TabBar>
        {scopable ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-pressed={scopeToSelected}
            title={
              scopeToSelected
                ? "Showing only the selected action's window — click to show all"
                : "Filter to the selected action's window"
            }
            onClick={() => setScopeToSelected((v) => !v)}
            className={cn("mb-1", scopeToSelected && "bg-bg-3 text-fg-2")}
          >
            <Crosshair />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {activeTab === "call" ? <CallTab {...tabProps} /> : null}
        {activeTab === "log" ? (
          <LogTab selectedAction={selectedAction} startTime={model.startTime} />
        ) : null}
        {activeTab === "errors" ? <ErrorsTab {...tabProps} /> : null}
        {activeTab === "console" ? <ConsoleTab {...tabProps} /> : null}
        {activeTab === "network" ? <NetworkTab {...tabProps} /> : null}
        {activeTab === "source" ? (
          // Keyed so a selection change remounts the tab — fresh default
          // file + frame index for the new action's stack (see SourceTab).
          <SourceTab key={selectedAction?.callId ?? ""} {...tabProps} />
        ) : null}
        {activeTab === "attachments" ? <AttachmentsTab {...tabProps} /> : null}
        {activeTab === "metadata" ? <MetadataTab {...tabProps} /> : null}
      </div>
    </div>
  );
}

function LogTab({
  selectedAction,
  startTime,
}: {
  selectedAction: TraceTabProps["selectedAction"];
  startTime: number;
}): React.ReactElement {
  const log = selectedAction?.log ?? [];
  if (log.length === 0) {
    return (
      <TabNotice>
        {selectedAction
          ? "No log entries for this action."
          : "Select an action to see its log."}
      </TabNotice>
    );
  }
  return (
    // `max-content` first column sizes to the widest offset so the message
    // column starts at one shared edge across every row.
    <div className="grid h-full grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-2 overflow-y-auto overscroll-contain py-1">
      {log.map((entry, i) => (
        <div
          key={i}
          className="col-span-full grid grid-cols-subgrid items-baseline px-3 py-0.5 font-mono text-caption"
        >
          <span className="text-right text-fg-4 tabular-nums">
            {formatTraceOffset(entry.time, startTime, { signed: false })}
          </span>
          <span className="whitespace-pre-wrap break-words text-fg-2">
            {entry.message.trim()}
          </span>
        </div>
      ))}
    </div>
  );
}
