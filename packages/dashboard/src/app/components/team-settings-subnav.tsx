import { cn } from "@/lib/cn";

type SubnavItem = "team" | "projects";

interface TeamSettingsSubnavProps {
  teamSlug: string;
  active: SubnavItem;
}

export function TeamSettingsSubnav({
  teamSlug,
  active,
}: TeamSettingsSubnavProps) {
  const items: { id: SubnavItem; label: string; href: string }[] = [
    { id: "team", label: "Team", href: `/settings/teams/${teamSlug}` },
    {
      id: "projects",
      label: "Projects",
      href: `/settings/teams/${teamSlug}/projects`,
    },
  ];

  return (
    <nav className="flex items-center gap-1 border-b border-border">
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <a
            key={item.id}
            href={item.href}
            className={cn(
              "relative px-3 py-2 text-sm transition-colors -mb-px border-b-2",
              isActive
                ? "text-foreground border-foreground font-medium"
                : "text-muted-foreground border-transparent hover:text-foreground",
            )}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
