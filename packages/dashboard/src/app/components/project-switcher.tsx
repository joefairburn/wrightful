"use client";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@/app/components/ui/combobox";

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
    <Combobox<Project>
      items={projects}
      defaultValue={current}
      itemToStringLabel={(p) => p.name}
      onValueChange={(next) => {
        if (next && next.slug !== currentProjectSlug) {
          window.location.href = `/t/${teamSlug}/p/${next.slug}`;
        }
      }}
    >
      <ComboboxInput
        aria-label="Select project"
        placeholder="Select project…"
        size="sm"
        className="w-48"
      />
      <ComboboxPopup>
        <ComboboxEmpty>No projects found.</ComboboxEmpty>
        <ComboboxList>
          {(project: Project) => (
            <ComboboxItem key={project.slug} value={project}>
              {project.name}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
