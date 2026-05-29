import {
  BarChart2,
  Boxes,
  CheckSquare,
  FlaskConical,
  Settings,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Fragment, useEffect, useMemo } from "react";
import { useNavigate } from "@/lib/navigate";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
} from "@/components/ui/command";
import { link } from "@/lib/links";

interface Team {
  slug: string;
  name: string;
}

interface Project {
  slug: string;
  name: string;
}

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTeam: Team | null;
  activeProject: Project | null;
  teams: Team[];
  projects: Project[];
}

type Action = () => void;

interface CommandEntry {
  /**
   * Used both as the React key and as the string the Autocomplete filters
   * against. Make it human-readable — it's what the user is typing to find
   * the item. Keep prefixes out (no "project foo"); filtering is substring.
   */
  value: string;
  label: string;
  icon: typeof CheckSquare;
  /** Optional secondary text (mono) — used for project slugs. */
  mono?: boolean;
  action: Action;
}

interface CommandGroupSpec {
  /** Group label shown in the popup. */
  value: string;
  items: CommandEntry[];
}

/**
 * ⌘K command menu built on the COSS `Command` primitive (Base UI
 * Autocomplete underneath). Three groups for v1: navigate within the active
 * project, switch project in the active team, switch team. Filtering is
 * automatic — `<Command items={groups}>` + `<CommandCollection>` lets
 * Autocomplete's default `mode: 'list'` substring-match against each
 * item's `value`, and `<CommandEmpty>` only renders when nothing matches.
 *
 * Selection fires the entry's `action` via the item's `onClick` — Base UI
 * Autocomplete items render as buttons and accept native React handlers,
 * so we don't need to route through `onValueChange` (which is for
 * input-text changes, not item selection).
 */
export function CommandMenu({
  open,
  onOpenChange,
  activeTeam,
  activeProject,
  teams,
  projects,
}: CommandMenuProps) {
  const navigate = useNavigate();

  const groups: CommandGroupSpec[] = useMemo(() => {
    const result: CommandGroupSpec[] = [];
    const go = (href: string) => {
      onOpenChange(false);
      navigate(href);
    };

    if (activeTeam && activeProject) {
      const base = link("/t/:teamSlug/p/:projectSlug", {
        teamSlug: activeTeam.slug,
        projectSlug: activeProject.slug,
      });
      result.push({
        value: "Navigate",
        items: [
          {
            value: "Runs",
            label: "Runs",
            icon: CheckSquare,
            action: () => go(base),
          },
          {
            value: "Flaky tests",
            label: "Flaky tests",
            icon: TriangleAlert,
            action: () => go(`${base}/flaky`),
          },
          {
            value: "Tests",
            label: "Tests",
            icon: FlaskConical,
            action: () => go(`${base}/tests`),
          },
          {
            value: "Insights",
            label: "Insights",
            icon: BarChart2,
            action: () => go(`${base}/insights`),
          },
          {
            value: "Settings",
            label: "Settings",
            icon: Settings,
            action: () => go("/settings/profile"),
          },
        ],
      });
    }

    if (activeTeam && projects.length > 0) {
      result.push({
        value: `Switch project in ${activeTeam.name}`,
        items: projects.map<CommandEntry>((p) => ({
          value: p.name,
          label: p.name,
          icon: Boxes,
          mono: true,
          action: () =>
            go(
              link("/t/:teamSlug/p/:projectSlug", {
                teamSlug: activeTeam.slug,
                projectSlug: p.slug,
              }),
            ),
        })),
      });
    }

    if (teams.length > 1) {
      result.push({
        value: "Switch team",
        items: teams.map<CommandEntry>((t) => ({
          value: t.name,
          label: t.name,
          icon: Users,
          action: () => go(link("/t/:teamSlug", { teamSlug: t.slug })),
        })),
      });
    }

    return result;
    // navigate is stable from Void; only re-derive when tenant context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam, activeProject, teams, projects]);

  return (
    <CommandDialog onOpenChange={onOpenChange} open={open}>
      <CommandDialogPopup>
        <Command items={groups}>
          <CommandInput placeholder="Search runs, tests, projects…" />
          <CommandPanel>
            <CommandEmpty>No matches</CommandEmpty>
            <CommandList>
              {(group: CommandGroupSpec, groupIndex: number) => (
                <Fragment key={group.value}>
                  {groupIndex > 0 && <CommandSeparator />}
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: CommandEntry) => (
                        <CommandItem
                          key={item.value}
                          onClick={item.action}
                          value={item.value}
                        >
                          <item.icon className="size-3.5 text-muted-foreground" />
                          <span className={item.mono ? "font-mono" : undefined}>
                            {item.label}
                          </span>
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

/**
 * Global ⌘K / Ctrl+K shortcut. Toggles the command menu open. Lifted here
 * so the listener tracks the menu's open state via the setter without
 * coupling the rest of the layout to keyboard plumbing.
 */
export function useCommandMenuShortcut(
  setOpen: (updater: (open: boolean) => boolean) => void,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isK = e.key === "k" || e.key === "K";
      if (!isK) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setOpen]);
}
