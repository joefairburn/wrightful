import { Check, ChevronsUpDown, FlaskConical, Plus } from "lucide-react";
import { useState } from "react";
import { fetch } from "void/client";
import { Link } from "@void/react";
import { useNavigate } from "@/lib/navigate";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { link } from "@/lib/links";

interface Team {
  slug: string;
  name: string;
}

interface Project {
  slug: string;
  name: string;
}

interface WorkspaceSwitcherProps {
  activeTeam: Team;
  activeProject: Project;
  teams: Team[];
  projects: Project[];
  isOwner: boolean;
}

/**
 * Sidebar-top picker that combines team + project navigation into a single
 * trigger, mirroring the Wrightful prototype's `TeamProjectMenu`. Replaces
 * the separate `<TeamSwitcher>` (top of sidebar) + `<ProjectSwitcher>` (top
 * header) — the header is gone, so both pickers consolidate here.
 *
 * The popover renders two sections: the user's teams (selecting one
 * navigates to `/t/:slug`, where Void resolves the user's last project for
 * that team) and the projects within the active team (mono font, settings
 * gear is omitted here — that lives in `/settings/teams/:slug/p/:slug/keys`
 * accessed via the user menu).
 */
export function WorkspaceSwitcher({
  activeTeam,
  activeProject,
  teams,
  projects,
  isOwner,
}: WorkspaceSwitcherProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const switchTeam = (slug: string) => {
    setOpen(false);
    if (slug === activeTeam.slug) return;
    void fetch("/api/user/last-team", {
      method: "POST",
      body: { teamSlug: slug },
    });
    navigate(link("/t/:teamSlug", { teamSlug: slug }));
  };

  const switchProject = (slug: string) => {
    setOpen(false);
    if (slug === activeProject.slug) return;
    void fetch("/api/user/last-project", {
      method: "POST",
      body: { teamSlug: activeTeam.slug, projectSlug: slug },
    });
    navigate(
      link("/t/:teamSlug/p/:projectSlug", {
        teamSlug: activeTeam.slug,
        projectSlug: slug,
      }),
    );
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors",
          "hover:bg-accent data-[popup-open]:bg-accent",
          "min-w-0",
        )}
      >
        <TeamBadge name={activeTeam.name} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">
            {activeTeam.name}
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {activeProject.name}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>

      <PopoverPopup
        align="start"
        className="w-60 **:data-[slot=popover-viewport]:p-1.5"
      >
        <SectionLabel>Teams</SectionLabel>
        <ul className="flex flex-col">
          {teams.map((t) => (
            <li key={t.slug}>
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  "hover:bg-accent",
                  t.slug === activeTeam.slug && "bg-accent",
                )}
                onClick={() => switchTeam(t.slug)}
                type="button"
              >
                <TeamBadge name={t.name} size="sm" />
                <span className="flex-1 truncate">{t.name}</span>
                {t.slug === activeTeam.slug && (
                  <Check className="size-3.5 text-foreground" />
                )}
              </button>
            </li>
          ))}
        </ul>

        <div className="my-1.5 h-px bg-border" />

        <SectionLabel>Projects in {activeTeam.name}</SectionLabel>
        <ul className="flex flex-col">
          {projects.map((p) => (
            <li key={p.slug}>
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  "font-mono text-[13px]",
                  "hover:bg-accent",
                  p.slug === activeProject.slug && "bg-accent",
                )}
                onClick={() => switchProject(p.slug)}
                type="button"
              >
                <FlaskConical className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{p.name}</span>
                {p.slug === activeProject.slug && (
                  <Check className="size-3.5 text-foreground" />
                )}
              </button>
            </li>
          ))}
        </ul>

        {isOwner && (
          <>
            <div className="my-1.5 h-px bg-border" />
            <Link
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              href={link("/settings/teams/:teamSlug/projects/new", {
                teamSlug: activeTeam.slug,
              })}
              onClick={() => setOpen(false)}
            >
              <Plus className="size-3.5" />
              <span>New project</span>
            </Link>
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Solid colored tile with the team initial. Color is derived from the team
 * slug so it's stable across renders. Steel-blue / cool-neutral palette to
 * match the prototype's restrained accent direction.
 */
function TeamBadge({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md";
}) {
  const initial = name.charAt(0).toUpperCase();
  const px = size === "sm" ? "size-4 text-[9.5px]" : "size-[22px] text-[12px]";
  const hue = teamHue(name);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white",
        px,
      )}
      style={{ background: `oklch(0.55 0.10 ${hue})` }}
    >
      {initial}
    </span>
  );
}

function teamHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  // Restrict to a cool 220-290° band so badges stay in the steel/indigo
  // family rather than scattering across the rainbow.
  return 220 + (Math.abs(h) % 70);
}
