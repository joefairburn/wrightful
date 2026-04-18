import {
  BarChart2,
  Bell,
  CheckSquare,
  CircleHelp,
  FlaskConical,
  GitFork,
  Settings,
  TriangleAlert,
  User,
} from "lucide-react";
import { cn } from "@/lib/cn";

interface ProjectShellProps {
  teamSlug: string;
  projectSlug: string;
  projectName: string;
  activeNav?: "runs" | "flaky" | "insights" | "tests";
  children: React.ReactNode;
}

export function ProjectShell({
  teamSlug,
  projectSlug,
  projectName,
  activeNav = "runs",
  children,
}: ProjectShellProps) {
  const base = `/t/${teamSlug}/p/${projectSlug}`;

  const navItems = [
    { href: base, label: "Runs", icon: CheckSquare, id: "runs" as const },
    {
      href: "#",
      label: "Flaky Tests",
      icon: TriangleAlert,
      id: "flaky" as const,
      disabled: true,
    },
    {
      href: "#",
      label: "Insights",
      icon: BarChart2,
      id: "insights" as const,
      disabled: true,
    },
    {
      href: "#",
      label: "Tests",
      icon: FlaskConical,
      id: "tests" as const,
      disabled: true,
    },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground font-sans">
      {/* Sidebar */}
      <nav className="fixed left-0 top-0 h-full w-64 flex flex-col border-r border-sidebar-border bg-sidebar z-50">
        <div className="px-5 py-5 flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center">
            <GitFork size={16} className="text-sidebar-foreground" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold tracking-tight text-sidebar-foreground leading-tight truncate">
              {projectName}
            </h1>
            <p className="text-xs text-sidebar-foreground/50 truncate">
              {teamSlug}
            </p>
          </div>
        </div>

        <div className="flex-1 flex flex-col gap-0.5 px-2 overflow-y-auto">
          {navItems.map((item) => {
            const active = activeNav === item.id;
            return (
              <a
                key={item.id}
                href={item.disabled ? undefined : item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors border-l-2",
                  active
                    ? "border-sidebar-primary bg-sidebar-accent text-sidebar-foreground font-semibold"
                    : "border-transparent text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  item.disabled &&
                    "opacity-40 cursor-not-allowed pointer-events-none",
                )}
              >
                <item.icon size={16} />
                {item.label}
              </a>
            );
          })}
        </div>

        <div className="flex flex-col gap-0.5 px-2 pb-5 shrink-0">
          <a
            href={`/admin/t/${teamSlug}/p/${projectSlug}/keys`}
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm border-l-2 border-transparent text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            <Settings size={16} />
            Settings
          </a>
        </div>
      </nav>

      {/* Main */}
      <main className="flex-1 ml-64 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-border bg-background sticky top-0 z-40">
          <span className="text-sm font-semibold text-foreground">
            {projectName}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Notifications"
            >
              <Bell size={18} />
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Help"
            >
              <CircleHelp size={18} />
            </button>
            <div className="w-8 h-8 rounded-full bg-muted border border-border flex items-center justify-center ml-1">
              <User size={14} className="text-muted-foreground" />
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          {children}
        </div>
      </main>
    </div>
  );
}
