import {
  ArrowLeft,
  BarChart2,
  CheckSquare,
  FlaskConical,
  Plus,
  Settings,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { Link, useRouter, useShared } from "@void/react";
// Command menu is wired up but temporarily hidden — re-enable by uncommenting
// the trigger button below + the `<CommandMenu>` + shortcut hook usage.
// import { CommandMenu, useCommandMenuShortcut } from "@/components/command-menu";
import { QueryProvider } from "@/components/query-provider";
import { SidebarUserMenu } from "@/components/sidebar-user-menu";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
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
 * Top-level app shell: integrated sidebar (no top header).
 *
 * Mirrors the Wrightful prototype layout: a single 240px sidebar carries
 * the team/project switcher, ⌘K jump-to, primary nav, and the user menu —
 * everything that used to live in a separate top header is now in the
 * sidebar footer or workspace switcher.
 *
 * Tenant + user + the settings shell's "back to app" target all come from
 * `useShared()`, populated by `middleware/01.context.ts`. Mounted
 * automatically by the route layouts under `pages/settings/` and
 * `pages/t/[teamSlug]/p/[projectSlug]/`.
 */
export function AppLayout({ children, mode }: AppLayoutProps) {
  const router = useRouter();
  const { auth, userTeams, activeTeam, teamProjects, activeProject } =
    useShared();
  const pathname = router.path;
  const user = auth?.user ?? null;

  // const [cmdOpen, setCmdOpen] = useState(false);
  // useCommandMenuShortcut(setCmdOpen);

  return (
    <QueryProvider>
      <div className="flex h-screen overflow-hidden bg-background text-foreground font-sans">
        <nav className="flex h-full w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
          {mode === "settings" ? (
            <SettingsSidebarContents pathname={pathname} teams={userTeams} />
          ) : (
            <AppSidebarContents
              activeProject={activeProject}
              activeTeam={activeTeam}
              onOpenCommand={() => {
                /* command menu disabled */
              }}
              pathname={pathname}
              teamProjects={teamProjects}
              teams={userTeams}
            />
          )}

          {user && (
            <div className="shrink-0 border-t border-sidebar-border p-2">
              <SidebarUserMenu
                email={user.email}
                image={user.image}
                name={user.name}
              />
            </div>
          )}
        </nav>

        <main className="flex flex-1 min-w-0 flex-col overflow-hidden">
          {children}
        </main>
      </div>

      {/* <CommandMenu
        activeProject={activeProject}
        activeTeam={activeTeam}
        onOpenChange={setCmdOpen}
        open={cmdOpen}
        projects={teamProjects}
        teams={userTeams}
      /> */}
    </QueryProvider>
  );
}

interface AppSidebarContentsProps {
  pathname: string;
  teams: { slug: string; name: string }[];
  teamProjects: { slug: string; name: string }[];
  activeTeam: { slug: string; name: string; role?: string } | null;
  activeProject: { slug: string; name: string } | null;
  onOpenCommand: () => void;
}

function AppSidebarContents({
  pathname,
  teams,
  teamProjects,
  activeTeam,
  activeProject,
  onOpenCommand: _onOpenCommand,
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
    count?: number;
  }[] = base
    ? [
        { href: base, label: "Runs", icon: CheckSquare, id: "runs" },
        {
          href: `${base}/flaky`,
          label: "Flaky tests",
          icon: TriangleAlert,
          id: "flaky",
        },
        {
          href: `${base}/tests`,
          label: "Tests",
          icon: FlaskConical,
          id: "tests",
        },
        {
          href: `${base}/insights`,
          label: "Insights",
          icon: BarChart2,
          id: "insights",
        },
      ]
    : [];

  return (
    <>
      <div className="shrink-0 px-2 pb-1.5 pt-2.5">
        {activeTeam && activeProject ? (
          <WorkspaceSwitcher
            activeProject={activeProject}
            activeTeam={activeTeam}
            isOwner={activeTeam.role === "owner"}
            projects={teamProjects}
            teams={teams}
          />
        ) : (
          <div className="flex h-9 items-center px-2 text-sm font-semibold tracking-tight">
            Wrightful
          </div>
        )}
      </div>

      {/* Jump to… (⌘K) — commented out until the command menu is ready for prime time. */}
      {/* <div className="shrink-0 px-2 pb-2">
        <button
          aria-label="Open command menu"
          className={cn(
            "flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-muted px-2.5 py-1.5",
            "text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          )}
          onClick={onOpenCommand}
          type="button"
        >
          <Search className="size-3.5" />
          <span>Jump to…</span>
          <span className="ml-auto inline-flex items-center gap-0.5">
            <Kbd className="h-4 min-w-4 px-1 text-[10px]">⌘</Kbd>
            <Kbd className="h-4 min-w-4 px-1 text-[10px]">K</Kbd>
          </span>
        </button>
      </div> */}

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {navItems.map((item) => {
          const active = activeNav === item.id;
          return (
            <Link
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                active
                  ? "bg-accent font-medium text-foreground"
                  : "text-sidebar-foreground hover:bg-accent hover:text-foreground",
              )}
              href={item.href}
              key={item.id}
            >
              <item.icon className="size-4" />
              <span className="flex-1">{item.label}</span>
              {item.count != null && (
                <span className="rounded-full bg-flaky-soft px-1.5 py-px font-mono text-[10.5px] font-semibold text-flaky tabular-nums">
                  {item.count}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      <div className="shrink-0 px-2 pb-2">
        <Link
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
            "text-sidebar-foreground hover:bg-accent hover:text-foreground",
          )}
          href="/settings/profile"
        >
          <Settings className="size-4" />
          Settings
        </Link>
      </div>
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
      <div className="shrink-0 px-2 pb-1.5 pt-2.5">
        <Link
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
            "text-sidebar-foreground hover:bg-accent hover:text-foreground",
          )}
          href={backToAppHref}
        >
          <ArrowLeft className="size-3.5" />
          Back to app
        </Link>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-1">
        <div className="flex flex-col gap-0.5">
          <SettingsSectionLabel>Account</SettingsSectionLabel>
          <Link
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              profileActive
                ? "bg-accent font-medium text-foreground"
                : "text-sidebar-foreground hover:bg-accent hover:text-foreground",
            )}
            href="/settings/profile"
          >
            <UserRound className="size-4" />
            Profile
          </Link>
        </div>

        <div className="flex flex-col gap-0.5">
          <SettingsSectionLabel>Your teams</SettingsSectionLabel>
          {teams.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">
              No teams yet.
            </p>
          ) : (
            teams.map((team) => {
              const href = `/settings/teams/${team.slug}`;
              const active =
                pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  className={cn(
                    "flex min-w-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-accent font-medium text-foreground"
                      : "text-sidebar-foreground hover:bg-accent hover:text-foreground",
                  )}
                  href={href}
                  key={team.slug}
                >
                  <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-sidebar-border bg-muted font-mono text-[10px] font-semibold uppercase text-muted-foreground">
                    {team.name.charAt(0)}
                  </span>
                  <span className="truncate">{team.name}</span>
                </Link>
              );
            })
          )}
          <Link
            className={cn(
              "mt-1 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              pathname === "/settings/teams/new"
                ? "bg-accent font-medium text-foreground"
                : "text-sidebar-foreground hover:bg-accent hover:text-foreground",
            )}
            href="/settings/teams/new"
          >
            <Plus className="size-4" />
            Create team
          </Link>
        </div>
      </div>
    </>
  );
}

function SettingsSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}
