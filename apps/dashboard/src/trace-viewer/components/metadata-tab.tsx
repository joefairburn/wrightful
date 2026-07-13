"use client";

import type React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatTraceDuration } from "../format";
import type { TraceTabProps } from "../model";
import { Field } from "./detail-shared";

/** Metadata's `dd`s are plain (no mono/muted styling, unlike Call's). */
function MetaField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return <Field label={label} value={value} className="text-13" />;
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
        <MetaField label="Browser" value={browser} />
        <MetaField label="Platform" value={model.platform || "—"} />
        <MetaField
          label="Playwright version"
          value={model.playwrightVersion || "—"}
        />
        <MetaField label="SDK language" value={model.sdkLanguage || "—"} />
        <MetaField label="Viewport" value={viewport} />
        <MetaField
          label="Test ID attribute"
          value={model.testIdAttributeName || "—"}
        />
        <MetaField label="Started" value={started} />
        <MetaField
          label="Duration"
          value={formatTraceDuration(model.endTime - model.startTime)}
        />
        <MetaField label="Pages" value={model.pages.length} />
        <MetaField
          label="Timeout"
          value={model.testTimeout ? `${model.testTimeout}ms` : "—"}
        />
      </dl>
    </ScrollArea>
  );
}
