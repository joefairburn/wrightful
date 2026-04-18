"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Check, ChevronsUpDown } from "lucide-react";
import * as React from "react";
import { Input } from "@/app/components/ui/input";
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
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);

  const filtered = query
    ? teams.filter((t) => t.name.toLowerCase().includes(query.toLowerCase()))
    : teams;

  function selectTeam(slug: string) {
    setOpen(false);
    setQuery("");
    if (slug !== currentTeamSlug) {
      window.location.href = `/t/${slug}`;
    }
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2",
          "text-sm font-semibold text-sidebar-foreground",
          "hover:bg-sidebar-accent transition-colors",
        )}
      >
        <span className="truncate">{currentTeamName}</span>
        <ChevronsUpDown size={14} className="shrink-0 opacity-50" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="start"
          side="bottom"
          sideOffset={4}
          className="z-50"
        >
          <PopoverPrimitive.Popup className="w-56 rounded-lg border bg-popover p-1 shadow-lg/5 outline-none data-starting-style:scale-98 data-starting-style:opacity-0 transition-[scale,opacity]">
            <div className="pb-1">
              <Input
                placeholder="Search teams…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                size="sm"
                autoFocus
              />
            </div>
            <ul className="flex flex-col gap-0.5">
              {filtered.length === 0 && (
                <li className="px-2 py-6 text-center text-sm text-muted-foreground">
                  No teams found.
                </li>
              )}
              {filtered.map((team) => {
                const active = team.slug === currentTeamSlug;
                return (
                  <li key={team.slug}>
                    <button
                      type="button"
                      onClick={() => selectTeam(team.slug)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                        "hover:bg-accent hover:text-accent-foreground transition-colors",
                        active && "font-medium",
                      )}
                    >
                      <Check
                        size={14}
                        className={cn("shrink-0", !active && "opacity-0")}
                      />
                      <span className="truncate">{team.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
