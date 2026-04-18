"use client";

import { ChevronsUpDown } from "lucide-react";
import * as React from "react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  ComboboxValue,
} from "@/app/components/ui/combobox";
import { cn } from "@/lib/cn";

interface Team {
  slug: string;
  name: string;
}

interface TeamSwitcherProps {
  currentTeamSlug: string;
  currentTeamName: string;
  teams: Team[];
}

export function TeamSwitcher({
  currentTeamSlug,
  currentTeamName,
  teams,
}: TeamSwitcherProps) {
  const current = teams.find((t) => t.slug === currentTeamSlug) ?? {
    slug: currentTeamSlug,
    name: currentTeamName,
  };
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  return (
    <Combobox<Team>
      items={teams}
      defaultValue={current}
      itemToStringLabel={(t) => t.name}
      onValueChange={(next) => {
        if (next && next.slug !== currentTeamSlug) {
          window.location.href = `/t/${next.slug}`;
        }
      }}
    >
      <ComboboxTrigger
        ref={triggerRef}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2",
          "text-sm font-semibold text-sidebar-foreground",
          "hover:bg-sidebar-accent transition-colors",
        )}
      >
        <ComboboxValue>
          {(value: Team | null) => (
            <span className="truncate">{value?.name ?? currentTeamName}</span>
          )}
        </ComboboxValue>
        <ChevronsUpDown size={14} className="shrink-0 opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup
        anchor={triggerRef}
        align="start"
        side="bottom"
        className="w-56"
      >
        <div className="p-1 border-b">
          <ComboboxInput placeholder="Search teams…" size="sm" />
        </div>
        <ComboboxList>
          {(team: Team) => (
            <ComboboxItem key={team.slug} value={team}>
              {team.name}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>No teams found.</ComboboxEmpty>
      </ComboboxPopup>
    </Combobox>
  );
}
