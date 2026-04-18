import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { TeamSettingsSubnav } from "@/app/components/team-settings-subnav";
import { Button } from "@/app/components/ui/button";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { resolveTeamBySlug } from "@/lib/authz";
import { param } from "@/lib/route-params";
import type { AppContext } from "@/worker";

export async function SettingsProjectsPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const teamSlug = param("teamSlug");
  const team = await resolveTeamBySlug(ctx.user.id, teamSlug);
  if (!team) return <NotFoundPage />;

  const db = getDb();
  const projectRows = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(eq(projects.teamId, team.id));

  const isOwner = team.role === "owner";

  return (
    <div className="mx-auto w-full max-w-4xl p-6 sm:p-8">
      <header className="mb-6">
        <h1 className="font-semibold text-2xl">{team.name}</h1>
        <p className="text-muted-foreground text-sm">Team settings</p>
      </header>

      <TeamSettingsSubnav teamSlug={team.slug} active="projects" />

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-lg">Projects</h2>
          {isOwner && (
            <Button
              render={
                <a href={`/settings/teams/${team.slug}/projects/new`}>
                  Create project
                </a>
              }
            />
          )}
        </div>
        {projectRows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No projects yet.</p>
        ) : (
          <ul className="divide-y border-y">
            {projectRows.map((p) => (
              <li key={p.id} className="flex items-center gap-4 py-2 text-sm">
                <strong className="flex-1 font-semibold">{p.name}</strong>
                <a
                  href={`/t/${team.slug}/p/${p.slug}`}
                  className="text-foreground underline-offset-4 hover:underline"
                >
                  Open
                </a>
                {isOwner && (
                  <a
                    href={`/settings/teams/${team.slug}/p/${p.slug}/keys`}
                    className="text-foreground underline-offset-4 hover:underline"
                  >
                    API keys
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
