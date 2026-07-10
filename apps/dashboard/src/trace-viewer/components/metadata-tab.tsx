"use client";

import type React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDuration } from "@/lib/time-format";
import type { TraceTabProps } from "../model";

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-12 font-medium tracking-[0.1px] text-fg-3">
        {label}
      </dt>
      <dd className="text-13">{value}</dd>
    </div>
  );
}

/** Trace/context metadata as a dense two-column definition grid. */
export function MetadataTab({ model }: TraceTabProps): React.ReactElement {
  const browser =
    [model.browserName, model.channel].filter(Boolean).join(" / ") || "—";
  const viewport = model.options.viewport
    ? `${model.options.viewport.width}×${model.options.viewport.height}`
    : "—";
  const started = model.wallTime
    ? new Date(model.wallTime).toLocaleString()
    : "—";

  return (
    <ScrollArea className="h-full">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 px-4 py-3">
        <Field label="Browser" value={browser} />
        <Field label="Platform" value={model.platform || "—"} />
        <Field
          label="Playwright version"
          value={model.playwrightVersion || "—"}
        />
        <Field label="SDK language" value={model.sdkLanguage || "—"} />
        <Field label="Viewport" value={viewport} />
        <Field
          label="Test ID attribute"
          value={model.testIdAttributeName || "—"}
        />
        <Field label="Started" value={started} />
        <Field
          label="Duration"
          value={formatDuration(model.endTime - model.startTime)}
        />
        <Field label="Pages" value={model.pages.length} />
        <Field
          label="Timeout"
          value={model.testTimeout ? `${model.testTimeout}ms` : "—"}
        />
      </dl>
    </ScrollArea>
  );
}
