import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { Button } from "@/app/components/ui/button";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { memberships, projects, user } from "@/db/schema";
import { resolveTeamBySlug } from "@/lib/authz";
import { param } from "@/lib/route-params";
import type { AppContext } from "@/worker";

export async function AdminTeamDetailPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const teamSlug = param("teamSlug");
  const team = await resolveTeamBySlug(ctx.user.id, teamSlug);
  if (!team) return <NotFoundPage />;

  const db = getDb();
  const [projectRows, memberRows] = await Promise.all([
    db
      .select({ id: projects.id, slug: projects.slug, name: projects.name })
      .from(projects)
      .where(eq(projects.teamId, team.id)),
    db
      .select({
        userId: memberships.userId,
        role: memberships.role,
        email: user.email,
        name: user.name,
      })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(eq(memberships.teamId, team.id)),
  ]);

  return (
    <div className="mx-auto max-w-4xl p-6 sm:p-8">
      <div className="mb-2">
        <a
          href="/admin/teams"
          className="text-muted-foreground text-sm hover:underline"
        >
          &larr; Teams
        </a>
      </div>
      <h1 className="mb-8 font-semibold text-2xl">{team.name}</h1>

      <h2 className="mb-3 font-semibold text-lg">Projects</h2>
      {projectRows.length === 0 ? (
        <p className="text-muted-foreground">No projects yet.</p>
      ) : (
        <ul className="divide-y border-y">
          {projectRows.map((p) => (
            <li key={p.id} className="flex items-center gap-4 py-2 text-sm">
              <strong className="flex-1 font-semibold">{p.name}</strong>
              <a
                href={`/t/${team.slug}/p/${p.slug}`}
                className="text-foreground underline-offset-4 hover:underline"
              >
                Runs
              </a>
              {team.role === "owner" && (
                <a
                  href={`/admin/t/${team.slug}/p/${p.slug}/keys`}
                  className="text-foreground underline-offset-4 hover:underline"
                >
                  API keys
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {team.role === "owner" && (
        <div className="mt-4">
          <Button
            render={
              <a href={`/admin/t/${team.slug}/projects/new`}>Create project</a>
            }
          />
        </div>
      )}

      <h2 className="mt-10 mb-3 font-semibold text-lg">Members</h2>
      <ul className="divide-y border-y">
        {memberRows.map((m) => (
          <li key={m.userId} className="flex items-center gap-4 py-2 text-sm">
            <span className="flex-1">
              {m.name}{" "}
              <span className="text-muted-foreground">({m.email})</span>
            </span>
            <span className="text-muted-foreground">{m.role}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
