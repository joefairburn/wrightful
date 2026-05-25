import { Boxes, Plus, Settings } from "lucide-react";
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

interface Project {
  slug: string;
  name: string;
}

interface ProjectSwitcherProps {
  teamSlug: string;
  currentProjectSlug: string;
  currentProjectName: string;
  projects: Project[];
  /** Project settings (`.../keys`) are owner-gated. Hide the gear + "Create
   *  project" footer for members so we don't ship them to a 404. */
  isOwner: boolean;
}

export function ProjectSwitcher({
  teamSlug,
  currentProjectSlug,
  currentProjectName,
  projects,
  isOwner,
}: ProjectSwitcherProps) {
  const navigate = useNavigate();
  const current = projects.find((p) => p.slug === currentProjectSlug) ?? {
    slug: currentProjectSlug,
    name: currentProjectName,
  };

  return (
    <NavCombobox<Project>
      items={projects}
      defaultValue={current}
      itemToStringLabel={(p) => p.name}
      onValueChange={(next) => {
        if (next && next.slug !== currentProjectSlug) {
          void fetch("/api/user/last-project", {
            method: "POST",
            body: { teamSlug, projectSlug: next.slug },
          });
          navigate(
            link("/t/:teamSlug/p/:projectSlug", {
              teamSlug,
              projectSlug: next.slug,
            }),
          );
        }
      }}
    >
      <NavComboboxTrigger aria-label="Select project">
        <NavComboboxValue>
          {(value: Project | null) => value?.name ?? currentProjectName}
        </NavComboboxValue>
      </NavComboboxTrigger>
      <NavComboboxPopup>
        <NavComboboxSearchInput placeholder="Find project…" />
        <NavComboboxList>
          {(project: Project) => (
            <NavComboboxItem
              key={project.slug}
              value={project}
              action={
                isOwner ? (
                  <Link
                    aria-label={`Project settings for ${project.name}`}
                    className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                    href={link(
                      "/settings/teams/:teamSlug/p/:projectSlug/keys",
                      { teamSlug, projectSlug: project.slug },
                    )}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    tabIndex={-1}
                  >
                    <Settings size={14} />
                  </Link>
                ) : undefined
              }
            >
              {project.name}
            </NavComboboxItem>
          )}
        </NavComboboxList>
        <NavComboboxEmpty icon={<Boxes />} title="No projects found" />
        {isOwner && (
          <NavComboboxFooter>
            <Button
              className="w-full justify-start"
              render={
                <Link
                  href={link("/settings/teams/:teamSlug/projects/new", {
                    teamSlug,
                  })}
                />
              }
              variant="ghost"
            >
              <Plus size={14} />
              Create project
            </Button>
          </NavComboboxFooter>
        )}
      </NavComboboxPopup>
    </NavCombobox>
  );
}
