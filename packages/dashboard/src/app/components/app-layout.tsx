import {
  ArrowLeft,
  BarChart2,
  Bell,
  CheckSquare,
  CircleHelp,
  FlaskConical,
  Plus,
  Settings,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import type { LayoutProps } from "rwsdk/router";
import { requestInfo } from "rwsdk/worker";
import { ProjectSwitcher } from "@/app/components/project-switcher";
import { QueryProvider } from "@/app/components/query-provider";
import { SidebarUserMenu } from "@/app/components/sidebar-user-menu";
import { TeamSwitcher } from "@/app/components/team-switcher";
import { NuqsRwsdkAdapter } from "@/lib/nuqs-rwsdk-adapter";
import {
  getSuggestedTeamsForUser,
  getTeamProjects,
  getUserTeams,
  resolveProjectBySlugs,
  resolveTeamBySlug,
  type SuggestedTeam,
} from "@/lib/authz";
import { cn } from "@/lib/cn";

type NavId = "runs" | "flaky" | "insights" | "tests";

function deriveActiveNav(pathname: string): NavId {
  if (/\/flaky(\/|$)/.test(pathname)) return "flaky";
  if (/\/insights(\/|$)/.test(pathname)) return "insights";
  if (/\/tests\//.test(pathname)) return "tests";
  return "runs";
}

type AppSidebarData = {
  teams: { slug: string; name: string }[];
  activeTeam: {
    slug: string;
    name: string;
    role: "owner" | "member";
  } | null;
  projects: { slug: string; name: string }[];
  activeProject: { slug: string; name: string } | null;
  suggestedTeams: SuggestedTeam[];
};

async function fetchAppSidebarData(
  userId: string | null,
  teamSlug: string | null,
  projectSlug: string | null,
): Promise<AppSidebarData> {
  if (!userId) {
    return {
      teams: [],
      activeTeam: null,
      projects: [],
      activeProject: null,
      suggestedTeams: [],
    };
  }
  const [teams, activeTeam, allSuggested] = await Promise.all([
    getUserTeams(userId),
    teamSlug ? resolveTeamBySlug(userId, teamSlug) : Promise.resolve(null),
    getSuggestedTeamsForUser(userId),
  ]);
  const projects = activeTeam ? await getTeamProjects(activeTeam.id) : [];
  const activeProject =
    teamSlug && projectSlug
      ? await resolveProjectBySlugs(userId, teamSlug, projectSlug)
      : null;
  // Sidebar hides dismissed suggestions; the profile page shows all.
  const suggestedTeams = allSuggested.filter((s) => !s.dismissed);
  return { teams, activeTeam, projects, activeProject, suggestedTeams };
}

export async function AppLayout({ children }: LayoutProps) {
  const { ctx, request } = requestInfo;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const serverSearch = url.search;
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

  const settingsTeams =
    mode === "settings" && userId ? await getUserTeams(userId) : [];

  return (
    <NuqsRwsdkAdapter serverSearch={serverSearch}>
      <QueryProvider>
        <div className="flex h-screen overflow-hidden bg-background text-foreground font-sans">
          <nav className="fixed left-0 top-0 h-full w-64 flex flex-col border-r border-sidebar-border bg-sidebar z-50">
            {mode === "settings" ? (
              <SettingsSidebarContents
                pathname={pathname}
                teams={settingsTeams}
              />
            ) : (
              <AppSidebarContents
                pathname={pathname}
                teams={app?.teams ?? []}
                activeTeam={app?.activeTeam ?? null}
                activeProject={app?.activeProject ?? null}
                suggestedTeams={app?.suggestedTeams ?? []}
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
                  isOwner={app.activeTeam.role === "owner"}
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
                {ctx.user && (
                  <SidebarUserMenu
                    name={ctx.user.name}
                    email={ctx.user.email}
                    image={ctx.user.image}
                  />
                )}
              </div>
            </header>

            <div className="flex-1 overflow-hidden flex flex-col min-h-0 overflow-y-auto">
              {children}
            </div>
          </main>
        </div>
      </QueryProvider>
    </NuqsRwsdkAdapter>
  );
}

interface AppSidebarContentsProps {
  pathname: string;
  teams: { slug: string; name: string }[];
  activeTeam: { slug: string; name: string } | null;
  activeProject: { slug: string; name: string } | null;
  suggestedTeams: SuggestedTeam[];
  signedIn: boolean;
}

function AppSidebarContents({
  pathname,
  teams,
  activeTeam,
  activeProject,
  suggestedTeams,
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
          href: `${base}/flaky`,
          label: "Flaky Tests",
          icon: TriangleAlert,
          id: "flaky",
        },
        {
          href: `${base}/insights`,
          label: "Insights",
          icon: BarChart2,
          id: "insights",
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
        <div className="h-14 px-2 shrink-0 flex items-center border-b border-sidebar-border">
          <TeamSwitcher
            currentTeamSlug={activeTeam.slug}
            currentTeamName={activeTeam.name}
            teams={teams}
            suggestedTeams={suggestedTeams.map((s) => ({
              id: s.id,
              slug: s.slug,
              name: s.name,
            }))}
          />
        </div>
      ) : (
        <div className="h-14 px-4 shrink-0 flex items-center text-sm font-semibold tracking-tight border-b border-sidebar-border">
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
  teams: { slug: string; name: string }[];
}

function SettingsSidebarContents({
  pathname,
  teams,
}: SettingsSidebarContentsProps) {
  const profileActive = pathname.startsWith("/settings/profile");

  return (
    <>
      <div className="h-14 px-2 shrink-0 flex items-center border-b border-sidebar-border">
        <a
          href="/"
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back to app
        </a>
      </div>

      <div className="flex-1 flex flex-col gap-4 px-2 overflow-y-auto">
        <div className="flex flex-col gap-0.5">
          <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Account
          </div>
          <a
            href="/settings/profile"
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors border-l-2",
              profileActive
                ? "border-sidebar-primary bg-sidebar-accent text-sidebar-foreground font-semibold"
                : "border-transparent text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
            )}
          >
            <UserRound size={16} />
            Profile
          </a>
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Your teams
          </div>
          {teams.length === 0 ? (
            <p className="px-3 py-1 text-sidebar-foreground/50 text-xs">
              No teams yet.
            </p>
          ) : (
            teams.map((team) => {
              const href = `/settings/teams/${team.slug}`;
              const active =
                pathname === href || pathname.startsWith(`${href}/`);
              return (
                <a
                  key={team.slug}
                  href={href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors border-l-2 min-w-0",
                    active
                      ? "border-sidebar-primary bg-sidebar-accent text-sidebar-foreground font-semibold"
                      : "border-transparent text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-sidebar-border bg-sidebar-accent font-mono font-semibold text-[10px] text-sidebar-foreground/70 uppercase">
                    {team.name.charAt(0)}
                  </span>
                  <span className="truncate">{team.name}</span>
                </a>
              );
            })
          )}
          <a
            href="/settings/teams/new"
            className={cn(
              "mt-1 flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors border-l-2",
              pathname === "/settings/teams/new"
                ? "border-sidebar-primary bg-sidebar-accent text-sidebar-foreground font-semibold"
                : "border-transparent text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
            )}
          >
            <Plus size={16} />
            Create team
          </a>
        </div>
      </div>
    </>
  );
}
