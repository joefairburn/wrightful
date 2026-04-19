import {
  ArrowLeft,
  BarChart2,
  Bell,
  CheckSquare,
  CircleHelp,
  FlaskConical,
  Settings,
  TriangleAlert,
  User,
  UserRound,
  Users,
} from "lucide-react";
import type { LayoutProps } from "rwsdk/router";
import { requestInfo } from "rwsdk/worker";
import { ProjectSwitcher } from "@/app/components/project-switcher";
import { QueryProvider } from "@/app/components/query-provider";
import { TeamSwitcher } from "@/app/components/team-switcher";
import {
  getTeamProjects,
  getUserTeams,
  resolveProjectBySlugs,
  resolveTeamBySlug,
} from "@/lib/authz";
import { cn } from "@/lib/cn";

type NavId = "runs" | "flaky" | "insights" | "tests";

function deriveActiveNav(pathname: string): NavId {
  if (/\/tests\//.test(pathname)) return "tests";
  return "runs";
}

type AppSidebarData = {
  teams: { slug: string; name: string }[];
  activeTeam: { slug: string; name: string } | null;
  projects: { slug: string; name: string }[];
  activeProject: { slug: string; name: string } | null;
};

async function fetchAppSidebarData(
  userId: string | null,
  teamSlug: string | null,
  projectSlug: string | null,
): Promise<AppSidebarData> {
  if (!userId) {
    return { teams: [], activeTeam: null, projects: [], activeProject: null };
  }
  const teams = await getUserTeams(userId);
  const activeTeam = teamSlug
    ? await resolveTeamBySlug(userId, teamSlug)
    : null;
  const projects = activeTeam ? await getTeamProjects(activeTeam.id) : [];
  const activeProject =
    teamSlug && projectSlug
      ? await resolveProjectBySlugs(userId, teamSlug, projectSlug)
      : null;
  return { teams, activeTeam, projects, activeProject };
}

export async function AppLayout({ children }: LayoutProps) {
  const { ctx, request } = requestInfo;
  const pathname = new URL(request.url).pathname;
  const mode: "app" | "settings" = pathname.startsWith("/settings")
    ? "settings"
    : "app";

  const params = requestInfo.params as Record<string, unknown>;
  const teamSlug = typeof params.teamSlug === "string" ? params.teamSlug : null;
  const projectSlug =
    typeof params.projectSlug === "string" ? params.projectSlug : null;

  const userId = ctx.user?.id ?? null;

  const app =
    mode === "app"
      ? await fetchAppSidebarData(userId, teamSlug, projectSlug)
      : null;

  return (
    <QueryProvider>
      <div className="flex h-screen overflow-hidden bg-background text-foreground font-sans">
        <nav className="fixed left-0 top-0 h-full w-64 flex flex-col border-r border-sidebar-border bg-sidebar z-50">
          {mode === "settings" ? (
            <SettingsSidebarContents pathname={pathname} />
          ) : (
            <AppSidebarContents
              pathname={pathname}
              teams={app?.teams ?? []}
              activeTeam={app?.activeTeam ?? null}
              activeProject={app?.activeProject ?? null}
              signedIn={!!userId}
            />
          )}
        </nav>

        <main className="flex-1 ml-64 flex flex-col min-w-0 overflow-hidden">
          <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-border bg-background sticky top-0 z-40">
            {mode === "app" && app?.activeTeam && app.activeProject ? (
              <ProjectSwitcher
                teamSlug={app.activeTeam.slug}
                currentProjectSlug={app.activeProject.slug}
                currentProjectName={app.activeProject.name}
                projects={app.projects}
              />
            ) : (
              <span />
            )}
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

          <div className="flex-1 overflow-hidden flex flex-col min-h-0 overflow-y-auto">
            {children}
          </div>
        </main>
      </div>
    </QueryProvider>
  );
}

interface AppSidebarContentsProps {
  pathname: string;
  teams: { slug: string; name: string }[];
  activeTeam: { slug: string; name: string } | null;
  activeProject: { slug: string; name: string } | null;
  signedIn: boolean;
}

function AppSidebarContents({
  pathname,
  teams,
  activeTeam,
  activeProject,
  signedIn,
}: AppSidebarContentsProps) {
  const activeNav = deriveActiveNav(pathname);
  const base =
    activeTeam && activeProject
      ? `/t/${activeTeam.slug}/p/${activeProject.slug}`
      : null;

  const navItems: {
    href: string;
    label: string;
    icon: typeof CheckSquare;
    id: NavId;
    disabled?: boolean;
  }[] = base
    ? [
        { href: base, label: "Runs", icon: CheckSquare, id: "runs" },
        {
          href: "#",
          label: "Flaky Tests",
          icon: TriangleAlert,
          id: "flaky",
          disabled: true,
        },
        {
          href: "#",
          label: "Insights",
          icon: BarChart2,
          id: "insights",
          disabled: true,
        },
        {
          href: "#",
          label: "Tests",
          icon: FlaskConical,
          id: "tests",
          disabled: true,
        },
      ]
    : [];

  return (
    <>
      {activeTeam ? (
        <div className="px-2 py-3 shrink-0">
          <TeamSwitcher
            currentTeamSlug={activeTeam.slug}
            currentTeamName={activeTeam.name}
            teams={teams}
          />
        </div>
      ) : (
        <div className="px-4 py-4 shrink-0 text-sm font-semibold tracking-tight">
          Wrightful
        </div>
      )}

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

      {signedIn ? (
        <div className="flex flex-col gap-0.5 px-2 pb-5 shrink-0">
          <a
            href="/settings"
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm border-l-2 border-transparent text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            <Settings size={16} />
            Settings
          </a>
        </div>
      ) : null}
    </>
  );
}

interface SettingsSidebarContentsProps {
  pathname: string;
}

function SettingsSidebarContents({ pathname }: SettingsSidebarContentsProps) {
  const groups: {
    label: string;
    items: {
      id: string;
      label: string;
      href: string;
      icon: typeof UserRound;
      match: (p: string) => boolean;
    }[];
  }[] = [
    {
      label: "Account",
      items: [
        {
          id: "profile",
          label: "Profile",
          href: "/settings/profile",
          icon: UserRound,
          match: (p) => p.startsWith("/settings/profile"),
        },
      ],
    },
    {
      label: "Workspaces",
      items: [
        {
          id: "teams",
          label: "Teams",
          href: "/settings/teams",
          icon: Users,
          match: (p) => p.startsWith("/settings/teams"),
        },
      ],
    },
  ];

  return (
    <>
      <div className="px-2 py-3 shrink-0">
        <a
          href="/"
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back to app
        </a>
      </div>

      <div className="flex-1 flex flex-col gap-4 px-2 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
              {group.label}
            </div>
            {group.items.map((item) => {
              const active = item.match(pathname);
              return (
                <a
                  key={item.id}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors border-l-2",
                    active
                      ? "border-sidebar-primary bg-sidebar-accent text-sidebar-foreground font-semibold"
                      : "border-transparent text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  )}
                >
                  <item.icon size={16} />
                  {item.label}
                </a>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
