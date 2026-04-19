"use client";

import { ChevronDownIcon, XIcon } from "lucide-react";
import { useMemo, useRef } from "react";
import { Button } from "@/app/components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxPrimitive,
  ComboboxTrigger,
} from "@/app/components/ui/combobox";
import { cn } from "@/lib/cn";

export const FILTER_TRIGGER_CLASSES =
  "group h-8 flex-1 min-w-0 justify-start gap-2 px-2.5 font-normal text-muted-foreground data-[has-value=true]:text-foreground";

export function TrailingAction({
  hasValue,
  onClear,
}: {
  hasValue: boolean;
  onClear: () => void;
}): React.ReactElement {
  if (hasValue) {
    return (
      <span
        aria-label="Clear"
        className="relative z-10 -mr-1 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClear();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        role="button"
      >
        <XIcon />
      </span>
    );
  }
  return <ChevronDownIcon className="size-3.5 opacity-60" />;
}

export function FilterTriggerButton({
  icon,
  label,
  hasValue,
  muted,
  onClear,
  ...buttonProps
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  hasValue: boolean;
  muted?: boolean;
  onClear: () => void;
} & React.ComponentProps<typeof Button>): React.ReactElement {
  return (
    <Button
      className={FILTER_TRIGGER_CLASSES}
      data-has-value={hasValue ? "true" : "false"}
      size="sm"
      variant="outline"
      {...buttonProps}
    >
      <span
        aria-hidden
        className="inline-flex shrink-0 items-center text-muted-foreground [&_svg]:size-3.5"
      >
        {icon}
      </span>
      <span
        className={cn(
          "flex-1 truncate text-left",
          muted && "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <TrailingAction hasValue={hasValue} onClear={onClear} />
    </Button>
  );
}

export type FilterOption = { value: string; label: string };

function buildDisplayValue(
  active: string[],
  labelByValue: Map<string, string>,
  label: string,
  placeholder: string,
  summary?: (count: number) => string,
): string {
  if (active.length === 0) return placeholder;
  if (summary) return `${label} · ${summary(active.length)}`;
  const [first, ...rest] = active;
  if (!first) return placeholder;
  const firstLabel = labelByValue.get(first) ?? first;
  if (rest.length === 0) return firstLabel;
  return `${firstLabel} +${rest.length}`;
}

export function MultiComboboxFilter({
  label,
  options,
  active,
  onChange,
  placeholder,
  icon,
  searchable = true,
  summary,
}: {
  label: string;
  options: FilterOption[];
  active: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  icon: React.ReactNode;
  searchable?: boolean;
  summary?: (count: number) => string;
}): React.ReactElement {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const labelByValue = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of options) map.set(o.value, o.label);
    return map;
  }, [options]);

  const displayValue = buildDisplayValue(
    active,
    labelByValue,
    label,
    placeholder,
    summary,
  );

  const hasValue = active.length > 0;

  return (
    <Combobox<string, true>
      itemToStringLabel={(v) => labelByValue.get(v) ?? v}
      items={options.map((o) => o.value)}
      multiple
      onValueChange={(next: string[]) => onChange(next)}
      value={active}
    >
      <ComboboxTrigger
        ref={triggerRef}
        render={
          <FilterTriggerButton
            aria-label={label}
            hasValue={hasValue}
            icon={icon}
            label={displayValue}
            muted={!hasValue}
            onClear={() => onChange([])}
          />
        }
      />
      <ComboboxPopup
        align="start"
        anchor={triggerRef}
        className="w-64 flex-col"
      >
        {searchable && (
          <div className="border-b border-border p-2">
            <ComboboxPrimitive.Input
              autoFocus
              className="h-7 w-full rounded-md border border-input bg-background px-2 text-sm outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
              placeholder={`Search ${label.toLowerCase()}`}
            />
          </div>
        )}
        <ComboboxList>
          {(value: string) => (
            <ComboboxItem key={value} value={value}>
              <span className="truncate">
                {labelByValue.get(value) ?? value}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>No matches</ComboboxEmpty>
        {hasValue && (
          <div className="flex justify-end border-t border-border p-1.5">
            <Button onClick={() => onChange([])} size="xs" variant="ghost">
              Clear
            </Button>
          </div>
        )}
      </ComboboxPopup>
    </Combobox>
  );
}
