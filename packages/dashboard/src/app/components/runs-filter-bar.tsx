"use client";

import { format, parseISO } from "date-fns";
import {
  CalendarIcon,
  CircleDotIcon,
  GitBranchIcon,
  SearchIcon,
  ServerIcon,
  UserIcon,
} from "lucide-react";
import { navigate } from "rwsdk/client";
import { useEffect, useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import {
  FilterTriggerButton,
  MultiComboboxFilter,
} from "@/app/components/filter-controls";
import { Button } from "@/app/components/ui/button";
import { Calendar } from "@/app/components/ui/calendar";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  type RunsFilters,
  RUN_STATUSES,
  type RunStatus,
  toSearchParams,
} from "@/lib/runs-filters";

type FilterOptions = {
  branches: string[];
  actors: string[];
  environments: string[];
};

type Props = {
  pathname: string;
  filters: RunsFilters;
  options: FilterOptions;
};

const STATUS_LABEL: Record<RunStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  flaky: "Flaky",
  timedout: "Timed out",
  interrupted: "Interrupted",
  skipped: "Skipped",
};

function formatDisplayDate(iso: string): string {
  return format(parseISO(iso), "dd/MM/yy");
}

function toIsoDate(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function applyFilters(pathname: string, next: RunsFilters): void {
  const qs = toSearchParams(next).toString();
  void navigate(qs ? `${pathname}?${qs}` : pathname, { history: "replace" });
}

export function RunsSearchInput({
  pathname,
  filters,
}: {
  pathname: string;
  filters: RunsFilters;
}): React.ReactElement {
  const [qLocal, setQLocal] = useState(filters.q);
  const debouncedQ = useDebouncedValue(qLocal, 300);

  useEffect(() => {
    if (debouncedQ === filters.q) return;
    applyFilters(pathname, { ...filters, q: debouncedQ });
    // Only debouncedQ should drive URL writes; filters/pathname changing on
    // their own must not re-fire this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  useEffect(() => {
    if (qLocal === debouncedQ) setQLocal(filters.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.q]);

  return (
    <div className="relative w-64">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground"
      />
      <input
        aria-label="Search runs"
        className="h-8 w-full rounded-lg border border-input bg-background pl-8 pr-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/72 shadow-xs/5 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 [&::-webkit-search-cancel-button]:appearance-none"
        onChange={(e) => setQLocal(e.target.value)}
        placeholder="Search commits, SHA, branch"
        type="search"
        value={qLocal}
      />
    </div>
  );
}

export function RunsFilterBar({
  pathname,
  filters,
  options,
}: Props): React.ReactElement {
  const apply = (next: RunsFilters): void => applyFilters(pathname, next);

  const range: DateRange | undefined = useMemo(() => {
    if (!filters.from && !filters.to) return undefined;
    return {
      from: filters.from ? parseISO(filters.from) : undefined,
      to: filters.to ? parseISO(filters.to) : undefined,
    };
  }, [filters.from, filters.to]);

  const dateLabel = (() => {
    if (filters.from && filters.to)
      return `${formatDisplayDate(filters.from)} – ${formatDisplayDate(filters.to)}`;
    if (filters.from) return `From ${formatDisplayDate(filters.from)}`;
    if (filters.to) return `Until ${formatDisplayDate(filters.to)}`;
    return null;
  })();

  const dateHasValue = Boolean(filters.from || filters.to);

  return (
    <div className="flex w-full items-center gap-2 min-w-0">
      <DateRangeFilter
        dateLabel={dateLabel}
        hasValue={dateHasValue}
        onApply={(from, to) => apply({ ...filters, from, to })}
        range={range}
      />

      <MultiComboboxFilter
        active={filters.actor}
        icon={<UserIcon />}
        label="Authors"
        onChange={(v) => apply({ ...filters, actor: v })}
        options={options.actors.map((a) => ({ value: a, label: a }))}
        placeholder="All Authors"
      />

      <MultiComboboxFilter
        active={filters.environment}
        icon={<ServerIcon />}
        label="Environments"
        onChange={(v) => apply({ ...filters, environment: v })}
        options={options.environments.map((e) => ({ value: e, label: e }))}
        placeholder="All Environments"
      />

      <MultiComboboxFilter
        active={filters.branch}
        icon={<GitBranchIcon />}
        label="Branches"
        onChange={(v) => apply({ ...filters, branch: v })}
        options={options.branches.map((b) => ({ value: b, label: b }))}
        placeholder="All Branches"
      />

      <MultiComboboxFilter
        active={filters.status}
        icon={<CircleDotIcon />}
        label="Status"
        onChange={(v) => {
          const allowed: ReadonlySet<string> = new Set(RUN_STATUSES);
          const status = v.filter((s): s is RunStatus => allowed.has(s));
          apply({ ...filters, status });
        }}
        options={RUN_STATUSES.map((s) => ({
          value: s,
          label: STATUS_LABEL[s],
        }))}
        placeholder="Status"
        searchable={false}
        summary={(count) => `${count}/${RUN_STATUSES.length}`}
      />
    </div>
  );
}

function DateRangeFilter({
  range,
  dateLabel,
  hasValue,
  onApply,
}: {
  range: DateRange | undefined;
  dateLabel: string | null;
  hasValue: boolean;
  onApply: (from: string | null, to: string | null) => void;
}): React.ReactElement {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <FilterTriggerButton
            aria-label="Date range"
            hasValue={hasValue}
            icon={<CalendarIcon />}
            label={dateLabel ?? "Select Date Range"}
            muted={!hasValue}
            onClear={() => onApply(null, null)}
          />
        }
      />
      <PopoverPopup align="start" className="p-2">
        <Calendar
          mode="range"
          onSelect={(selected: DateRange | undefined) =>
            onApply(
              selected?.from ? toIsoDate(selected.from) : null,
              selected?.to ? toIsoDate(selected.to) : null,
            )
          }
          selected={range}
        />
        {hasValue && (
          <div className="flex justify-end pt-2">
            <Button
              onClick={() => onApply(null, null)}
              size="xs"
              variant="ghost"
            >
              Clear dates
            </Button>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
