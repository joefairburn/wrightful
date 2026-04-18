"use client";

import { ChevronsUpDown } from "lucide-react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  ComboboxValue,
} from "@/app/components/ui/combobox";
import { cn } from "@/lib/cn";

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
      <ComboboxTrigger
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2 py-1.5",
          "text-sm font-semibold text-foreground",
          "hover:bg-accent transition-colors",
        )}
      >
        <ComboboxValue>
          {(value: Project | null) => (
            <span className="truncate">
              {value?.name ?? currentProjectName}
            </span>
          )}
        </ComboboxValue>
        <ChevronsUpDown size={14} className="shrink-0 opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" side="bottom" className="w-56">
        <div className="p-1 border-b">
          <ComboboxInput placeholder="Search projects…" size="sm" />
        </div>
        <ComboboxList>
          {(project: Project) => (
            <ComboboxItem key={project.slug} value={project}>
              {project.name}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>No projects found.</ComboboxEmpty>
      </ComboboxPopup>
    </Combobox>
  );
}
