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
import { Link, useRouter, useShared } from "@void/react";
import { ProjectSwitcher } from "@/components/project-switcher";
import { QueryProvider } from "@/components/query-provider";
import { SidebarUserMenu } from "@/components/sidebar-user-menu";
import { TeamSwitcher } from "@/components/team-switcher";
import { cn } from "@/lib/cn";

type NavId = "runs" | "flaky" | "insights" | "tests";

function deriveActiveNav(pathname: string): NavId {
  if (/\/flaky(\/|$)/.test(pathname)) return "flaky";
  if (/\/insights(\/|$)/.test(pathname)) return "insights";
  if (/\/tests(\/|$)/.test(pathname)) return "tests";
  return "runs";
}

interface AppLayoutProps {
  children: React.ReactNode;
  /**
   * Settings mode swaps the sidebar for the account/teams chrome. The route
   * layouts pass this explicitly: `pages/settings/layout.tsx` sets
   * `"settings"`, `pages/t/[teamSlug]/p/[projectSlug]/layout.tsx` sets
   * `"app"`. Inferred from the URL only as a defensive fallback.
   */
  mode: "app" | "settings";
}

/**
 * Top-level app shell: sidebar + header + content area. Tenant + user + the
 * settings shell's "back to app" target all come from `useShared()`, which
 * is populated by `middleware/01.context.ts`. Mounted automatically by the
 * route layouts under `pages/settings/` and `pages/t/[teamSlug]/p/[projectSlug]/`.
 */
export function AppLayout({ children, mode }: AppLayoutProps) {
  const router = useRouter();
  const { auth, userTeams, activeTeam, teamProjects, activeProject } =
    useShared();
  const pathname = router.path;
  const user = auth?.user ?? null;

  return (
    <QueryProvider>
      <div className="flex h-screen overflow-hidden bg-background text-foreground font-sans">
        <nav className="fixed left-0 top-0 h-full w-64 flex flex-col border-r border-sidebar-border bg-sidebar z-50">
          {mode === "settings" ? (
            <SettingsSidebarContents pathname={pathname} teams={userTeams} />
          ) : (
            <AppSidebarContents
              pathname={pathname}
              teams={userTeams}
              activeTeam={activeTeam}
              activeProject={activeProject}
              signedIn={!!user}
            />
          )}
        </nav>

        <main className="flex-1 ml-64 flex flex-col min-w-0 overflow-hidden">
          <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-border bg-background sticky top-0 z-40">
            {mode === "app" && activeTeam && activeProject ? (
              <ProjectSwitcher
                teamSlug={activeTeam.slug}
                currentProjectSlug={activeProject.slug}
                currentProjectName={activeProject.name}
                projects={teamProjects}
                isOwner={activeTeam.role === "owner"}
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
              {user && (
                <SidebarUserMenu
                  name={user.name}
                  email={user.email}
                  image={user.image}
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
  );
}

interface AppSidebarContentsProps {
  pathname: string;
  teams: { slug: string; name: string }[];
  activeTeam: { slug: string; name: string; role?: string } | null;
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
          href: `${base}/tests`,
          label: "Tests",
          icon: FlaskConical,
          id: "tests",
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
          const className = cn(
            "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
            active
              ? "bg-sidebar-accent text-sidebar-foreground font-semibold"
              : "text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
            item.disabled &&
              "opacity-40 cursor-not-allowed pointer-events-none",
          );
          if (item.disabled) {
            return (
              <span key={item.id} className={className} aria-disabled>
                <item.icon size={16} />
                {item.label}
              </span>
            );
          }
          return (
            <Link key={item.id} href={item.href} className={className}>
              <item.icon size={16} />
              {item.label}
            </Link>
          );
        })}
      </div>

      {signedIn ? (
        <div className="flex flex-col gap-0.5 px-2 pb-5 shrink-0">
          <Link
            href="/settings/profile"
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            <Settings size={16} />
            Settings
          </Link>
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
  const { backToAppHref } = useShared();
  const profileActive = pathname.startsWith("/settings/profile");

  return (
    <>
      <div className="h-14 px-2 shrink-0 flex items-center border-b border-sidebar-border">
        <Link
          href={backToAppHref}
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back to app
        </Link>
      </div>

      <div className="flex-1 flex flex-col gap-4 px-2 overflow-y-auto">
        <div className="flex flex-col gap-0.5">
          <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Account
          </div>
          <Link
            href="/settings/profile"
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
              profileActive
                ? "bg-sidebar-accent text-sidebar-foreground font-semibold"
                : "text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
            )}
          >
            <UserRound size={16} />
            Profile
          </Link>
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
                <Link
                  key={team.slug}
                  href={href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors min-w-0",
                    active
                      ? "bg-sidebar-accent text-sidebar-foreground font-semibold"
                      : "text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-sidebar-border bg-sidebar-accent font-mono font-semibold text-[10px] text-sidebar-foreground/70 uppercase">
                    {team.name.charAt(0)}
                  </span>
                  <span className="truncate">{team.name}</span>
                </Link>
              );
            })
          )}
          <Link
            href="/settings/teams/new"
            className={cn(
              "mt-1 flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
              pathname === "/settings/teams/new"
                ? "bg-sidebar-accent text-sidebar-foreground font-semibold"
                : "text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground",
            )}
          >
            <Plus size={16} />
            Create team
          </Link>
        </div>
      </div>
    </>
  );
}
