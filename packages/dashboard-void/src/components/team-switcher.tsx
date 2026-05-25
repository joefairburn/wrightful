import { Plus, Settings, Users } from "lucide-react";
import * as React from "react";
import { fetch } from "void/client";
import { Link } from "@void/react";
import { useNavigate } from "@/lib/navigate";
import { Button } from "@/components/ui/button";
import { link } from "@/lib/links";
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
} from "@/components/ui/nav-combobox";

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
  const navigate = useNavigate();
  const currentJoined: Team = teams.find((t) => t.slug === currentTeamSlug) ?? {
    slug: currentTeamSlug,
    name: currentTeamName,
  };

  const currentItem: Team = React.useMemo(
    () => ({ slug: currentJoined.slug, name: currentJoined.name }),
    [currentJoined.slug, currentJoined.name],
  );

  return (
    <NavCombobox<Team>
      items={teams}
      defaultValue={currentItem}
      itemToStringLabel={(t) => t.name}
      onValueChange={(next) => {
        if (!next) return;
        if (next.slug !== currentTeamSlug) {
          void fetch("/api/user/last-team", {
            method: "POST",
            body: { teamSlug: next.slug },
          });
          navigate(link("/t/:teamSlug", { teamSlug: next.slug }));
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
          {(item: Team) => (
            <JoinedItem key={`joined:${item.slug}`} item={item} />
          )}
        </NavComboboxList>
        <NavComboboxEmpty icon={<Users />} title="No teams found" />
        <NavComboboxFooter>
          <Button
            className="w-full justify-start"
            render={<Link href={link("/settings/teams/new")} />}
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

function JoinedItem({ item }: { item: Team }) {
  return (
    <NavComboboxItem
      value={item}
      action={
        <Link
          aria-label={`Team settings for ${item.name}`}
          className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
          href={link("/settings/teams/:teamSlug", { teamSlug: item.slug })}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          tabIndex={-1}
        >
          <Settings size={14} />
        </Link>
      }
    >
      {item.name}
    </NavComboboxItem>
  );
}
