"use client";

import { Boxes, Plus, Settings } from "lucide-react";
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

interface Project {
  slug: string;
  name: string;
}

interface ProjectSwitcherProps {
  teamSlug: string;
  currentProjectSlug: string;
  currentProjectName: string;
  projects: Project[];
}

export function ProjectSwitcher({
  teamSlug,
  currentProjectSlug,
  currentProjectName,
  projects,
}: ProjectSwitcherProps) {
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
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamSlug, projectSlug: next.slug }),
            keepalive: true,
          });
          void navigate(
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
                <a
                  aria-label={`Project settings for ${project.name}`}
                  className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                  href={link("/settings/teams/:teamSlug/p/:projectSlug/keys", {
                    teamSlug,
                    projectSlug: project.slug,
                  })}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  tabIndex={-1}
                >
                  <Settings size={14} />
                </a>
              }
            >
              {project.name}
            </NavComboboxItem>
          )}
        </NavComboboxList>
        <NavComboboxEmpty icon={<Boxes />} title="No projects found" />
        <NavComboboxFooter>
          <Button
            className="w-full justify-start"
            render={
              <a
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
      </NavComboboxPopup>
    </NavCombobox>
  );
}
