"use client";

import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import type React from "react";
import { useRef, useState } from "react";
import { ALL_BRANCHES } from "@/app/components/run-history-branch-filter.shared";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxPrimitive,
  ComboboxTrigger,
} from "@/app/components/ui/combobox";

function branchLabel(v: string): string {
  return v === ALL_BRANCHES ? "All branches" : v;
}

/**
 * Inline branch filter for the run history chart subtitle.
 *
 * Writes `?branch=<name>` (or `?branch=__all__`) with `shallow: false` so
 * rwsdk re-renders the page server-side with the new filter — no client-
 * side data fetching needed.
 *
 * `defaultValue` must match what the server used when computing the current
 * history: the resolved effective branch. On a URL without `?branch`, that's
 * the current run's branch (or `ALL_BRANCHES` when the current run has no
 * branch). Pinning the nuqs default to that value keeps SSR and the initial
 * CSR render in sync and prevents a hydration flash.
 */
export function RunHistoryBranchFilter({
  defaultValue,
  branches,
}: {
  defaultValue: string;
  branches: string[];
}): React.ReactElement {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Control the combobox input ourselves so selecting a value doesn't leave
  // its label in the input (Base UI's default single-select behavior), which
  // would then filter the list down to only items matching that label on the
  // next open.
  const [query, setQuery] = useState("");

  const [branch, setBranch] = useQueryState(
    "branch",
    parseAsString.withDefault(defaultValue).withOptions({
      shallow: false,
      history: "replace",
      // Keep the param in the URL even when it matches the default, so the
      // current selection is always unambiguously shareable.
      clearOnDefault: false,
    }),
  );

  // If the default value (current run's branch) isn't among the project's
  // distinct branches — can happen on a freshly-created branch where the
  // only run is the current one but we filtered it out because `committed`
  // wasn't yet 1 — fold it back into the list so it renders as an option.
  const items = [
    ALL_BRANCHES,
    ...(branches.includes(defaultValue) || defaultValue === ALL_BRANCHES
      ? branches
      : [defaultValue, ...branches]),
  ];

  return (
    <Combobox<string>
      items={items}
      itemToStringLabel={branchLabel}
      onValueChange={(next: string | null) => {
        void setBranch(next ?? ALL_BRANCHES);
      }}
      value={branch}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <ComboboxTrigger
        ref={triggerRef}
        render={
          <button
            aria-label="Filter history by branch"
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[11px] text-muted-foreground outline-none transition-colors cursor-pointer hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          >
            <GitBranchIcon className="size-3 opacity-80" aria-hidden />
            <span className="max-w-40 truncate">{branchLabel(branch)}</span>
            <ChevronDownIcon className="size-3 opacity-70" aria-hidden />
          </button>
        }
      />
      <ComboboxPopup
        align="start"
        anchor={triggerRef}
        className="w-56 flex-col"
      >
        {branches.length > 5 && (
          <div className="border-b border-border p-2">
            <ComboboxPrimitive.Input
              autoFocus
              className="h-7 w-full rounded-md border border-input bg-background px-2 text-sm outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
              placeholder="Search branches"
            />
          </div>
        )}
        <ComboboxList>
          {(v: string) => (
            <ComboboxItem key={v} value={v}>
              <span className="truncate">{branchLabel(v)}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>No matches</ComboboxEmpty>
      </ComboboxPopup>
    </Combobox>
  );
}
