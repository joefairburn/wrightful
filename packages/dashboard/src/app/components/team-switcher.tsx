"use client";

import { Check, Plus, Settings, Users, X } from "lucide-react";
import * as React from "react";
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
import { cn } from "@/lib/cn";

interface Team {
  slug: string;
  name: string;
}

interface SuggestedTeam {
  id: string;
  slug: string;
  name: string;
}

type TeamItem =
  | { kind: "joined"; slug: string; name: string }
  | { kind: "suggested"; id: string; slug: string; name: string };

interface TeamSwitcherProps {
  currentTeamSlug: string;
  currentTeamName: string;
  teams: Team[];
  suggestedTeams?: SuggestedTeam[];
}

export function TeamSwitcher({
  currentTeamSlug,
  currentTeamName,
  teams,
  suggestedTeams = [],
}: TeamSwitcherProps) {
  const currentJoined =
    teams.find((t) => t.slug === currentTeamSlug) ??
    ({ slug: currentTeamSlug, name: currentTeamName } as Team);

  const items = React.useMemo<TeamItem[]>(
    () => [
      ...teams.map<TeamItem>((t) => ({
        kind: "joined",
        slug: t.slug,
        name: t.name,
      })),
      ...suggestedTeams.map<TeamItem>((s) => ({
        kind: "suggested",
        id: s.id,
        slug: s.slug,
        name: s.name,
      })),
    ],
    [teams, suggestedTeams],
  );

  const currentItem: TeamItem = React.useMemo(
    () => ({
      kind: "joined",
      slug: currentJoined.slug,
      name: currentJoined.name,
    }),
    [currentJoined.slug, currentJoined.name],
  );

  const [locallyDismissed, setLocallyDismissed] = React.useState<Set<string>>(
    () => new Set(),
  );

  const dismiss = React.useCallback((teamId: string) => {
    setLocallyDismissed((prev) => {
      const next = new Set(prev);
      next.add(teamId);
      return next;
    });
    void fetch(`/api/user/team-suggestions/${teamId}/dismiss`, {
      method: "POST",
      keepalive: true,
    });
  }, []);

  const visibleItems = React.useMemo(
    () =>
      items.filter(
        (i) => i.kind !== "suggested" || !locallyDismissed.has(i.id),
      ),
    [items, locallyDismissed],
  );

  return (
    <NavCombobox<TeamItem>
      items={visibleItems}
      defaultValue={currentItem}
      itemToStringLabel={(t) => t.name}
      onValueChange={(next) => {
        if (!next) return;
        if (next.kind === "suggested") return; // Join/Dismiss handle activation.
        if (next.slug !== currentTeamSlug) {
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
          {(value: TeamItem | null) =>
            (value?.kind === "joined" ? value.name : null) ?? currentTeamName
          }
        </NavComboboxValue>
      </NavComboboxTrigger>
      <NavComboboxPopup>
        <NavComboboxSearchInput placeholder="Find team…" />
        <NavComboboxList>
          {(item: TeamItem) =>
            item.kind === "joined" ? (
              <JoinedItem key={`joined:${item.slug}`} item={item} />
            ) : (
              <SuggestedItem
                key={`suggested:${item.id}`}
                item={item}
                onDismiss={() => dismiss(item.id)}
              />
            )
          }
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

function JoinedItem({
  item,
}: {
  item: { kind: "joined"; slug: string; name: string };
}) {
  return (
    <NavComboboxItem
      value={item}
      action={
        <a
          aria-label={`Team settings for ${item.name}`}
          className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
          href={link("/settings/teams/:teamSlug", { teamSlug: item.slug })}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          tabIndex={-1}
        >
          <Settings size={14} />
        </a>
      }
    >
      {item.name}
    </NavComboboxItem>
  );
}

function SuggestedItem({
  item,
  onDismiss,
}: {
  item: { kind: "suggested"; id: string; slug: string; name: string };
  onDismiss: () => void;
}) {
  return (
    <NavComboboxItem
      value={item}
      action={
        <span className="flex items-center gap-1">
          <form
            action={`/t/${item.slug}/join`}
            method="post"
            className={cn("m-0")}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              aria-label={`Join ${item.name}`}
              title="Join"
              type="submit"
              className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-success"
              tabIndex={-1}
            >
              <Check size={14} />
            </button>
          </form>
          <button
            type="button"
            aria-label={`Dismiss ${item.name}`}
            title="Dismiss"
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-destructive-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            tabIndex={-1}
          >
            <X size={14} />
          </button>
        </span>
      }
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate">{item.name}</span>
        <span className="shrink-0 rounded-sm border border-border/50 bg-background px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground uppercase tracking-wider">
          Join
        </span>
      </span>
    </NavComboboxItem>
  );
}
