"use client";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@/app/components/ui/combobox";

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
      <ComboboxInput
        aria-label="Select team"
        placeholder="Select team…"
        size="sm"
        className="w-full"
      />
      <ComboboxPopup>
        <ComboboxEmpty>No teams found.</ComboboxEmpty>
        <ComboboxList>
          {(team: Team) => (
            <ComboboxItem key={team.slug} value={team}>
              {team.name}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
