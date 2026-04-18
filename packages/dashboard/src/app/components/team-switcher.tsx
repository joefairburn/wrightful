"use client";

import { Plus, Users } from "lucide-react";
import { navigate } from "rwsdk/client";
import { Button } from "@/app/components/ui/button";
import { link } from "@/app/links";
import {
  NavCombobox,
  NavComboboxEmpty,
  NavComboboxFooter,
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
          void fetch("/api/user/last-team", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamSlug: next.slug }),
            keepalive: true,
          });
          void navigate(link("/t/:teamSlug", { teamSlug: next.slug }));
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
        <NavComboboxFooter>
          <Button
            className="w-full justify-start"
            render={<a href={link("/settings/teams/new")} />}
            variant="ghost"
          >
            <Plus size={14} />
            Create team
          </Button>
        </NavComboboxFooter>
      </NavComboboxPopup>
    </NavCombobox>
  );
}
