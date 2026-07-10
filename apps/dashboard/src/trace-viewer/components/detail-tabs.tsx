"use client";

import { Crosshair } from "lucide-react";
import { useEffect, useState } from "react";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/time-format";
import type { TraceTabProps } from "../model";
import type { TraceBridge } from "../use-trace-model";
import { AttachmentsTab } from "./attachments-tab";
import { CallTab } from "./call-tab";
import { ConsoleTab } from "./console-tab";
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
  const consoleCount = model.events.filter(
    (e) =>
      e.type === "console" || (e.type === "event" && e.method === "pageError"),
  ).length;
  const [tab, setTab] = useState<DetailTabId>(
    errorCount > 0 ? "errors" : "call",
  );
  const [scopeToSelected, setScopeToSelected] = useState(false);
  // A new trace (model identity change) re-evaluates the default.
  useEffect(() => {
    setTab(model.errorDescriptors.length > 0 ? "errors" : "call");
  }, [model]);

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

  const scopable = tab === "console" || tab === "network";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-end justify-between gap-2 pr-2">
        <TabBar className="min-w-0 flex-1 px-2" role="tablist">
          {tabs.map(({ id, label, count }) => (
            <TabBarTab key={id} active={tab === id} onSelect={() => setTab(id)}>
              {label}
              {count ? (
                <span className="ml-1 text-11 text-fg-4 tabular-nums">
                  {count}
                </span>
              ) : null}
            </TabBarTab>
          ))}
        </TabBar>
        {scopable ? (
          <button
            type="button"
            aria-pressed={scopeToSelected}
            title={
              scopeToSelected
                ? "Showing only the selected action's window — click to show all"
                : "Filter to the selected action's window"
            }
            onClick={() => setScopeToSelected((v) => !v)}
            className={cn(
              "mb-1 flex size-6 shrink-0 items-center justify-center rounded",
              scopeToSelected
                ? "bg-bg-3 text-fg-2"
                : "text-fg-4 hover:text-fg-2",
            )}
          >
            <Crosshair className="size-3.5" />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "call" ? <CallTab {...tabProps} /> : null}
        {tab === "log" ? (
          <LogTab selectedAction={selectedAction} startTime={model.startTime} />
        ) : null}
        {tab === "errors" ? <ErrorsTab {...tabProps} /> : null}
        {tab === "console" ? <ConsoleTab {...tabProps} /> : null}
        {tab === "network" ? <NetworkTab {...tabProps} /> : null}
        {tab === "source" ? <SourceTab {...tabProps} /> : null}
        {tab === "attachments" ? <AttachmentsTab {...tabProps} /> : null}
        {tab === "metadata" ? <MetadataTab {...tabProps} /> : null}
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
      <div className="px-3 py-4 text-12 text-fg-4">
        {selectedAction
          ? "No log entries for this action."
          : "Select an action to see its log."}
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto overscroll-contain py-1">
      {log.map((entry, i) => (
        <div
          key={i}
          className="flex items-baseline gap-2 px-3 py-0.5 font-mono text-12"
        >
          <span className="shrink-0 text-fg-4 tabular-nums">
            {formatDuration(Math.max(0, Math.round(entry.time - startTime)))}
          </span>
          <span className="min-w-0 whitespace-pre-wrap break-words text-fg-2">
            {entry.message}
          </span>
        </div>
      ))}
    </div>
  );
}
