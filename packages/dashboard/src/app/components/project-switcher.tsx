"use client";

import { Boxes, Plus } from "lucide-react";
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
          window.location.href = `/t/${teamSlug}/p/${next.slug}`;
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
            <NavComboboxItem key={project.slug} value={project}>
              {project.name}
            </NavComboboxItem>
          )}
        </NavComboboxList>
        <NavComboboxEmpty icon={<Boxes />} title="No projects found" />
        <NavComboboxFooter>
          <a href={`/admin/t/${teamSlug}/projects/new`}>
            <Plus size={14} />
            Create project
          </a>
        </NavComboboxFooter>
      </NavComboboxPopup>
    </NavCombobox>
  );
}
