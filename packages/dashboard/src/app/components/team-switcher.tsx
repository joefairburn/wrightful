"use client";

import { Users } from "lucide-react";
import {
  NavCombobox,
  NavComboboxEmpty,
  NavComboboxItem,
  NavComboboxList,
  NavComboboxPopup,
  NavComboboxSearchInput,
  NavComboboxTrigger,
  NavComboboxValue,
} from "@/app/components/ui/nav-combobox";

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

  return (
    <NavCombobox<Team>
      items={teams}
      defaultValue={current}
      itemToStringLabel={(t) => t.name}
      onValueChange={(next) => {
        if (next && next.slug !== currentTeamSlug) {
          window.location.href = `/t/${next.slug}`;
        }
      }}
    >
      <NavComboboxTrigger aria-label="Select team">
        <NavComboboxValue>
          {(value: Team | null) => value?.name ?? currentTeamName}
        </NavComboboxValue>
      </NavComboboxTrigger>
      <NavComboboxPopup>
        <NavComboboxSearchInput placeholder="Find team…" />
        <NavComboboxList>
          {(team: Team) => (
            <NavComboboxItem key={team.slug} value={team}>
              {team.name}
            </NavComboboxItem>
          )}
        </NavComboboxList>
        <NavComboboxEmpty icon={<Users />} title="No teams found" />
      </NavComboboxPopup>
    </NavCombobox>
  );
}
