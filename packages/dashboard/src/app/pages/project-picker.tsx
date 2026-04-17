import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { resolveTeamBySlug } from "@/lib/authz";
import { param } from "@/lib/route-params";
import type { AppContext } from "@/worker";

export async function ProjectPickerPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const teamSlug = param("teamSlug");
  const team = await resolveTeamBySlug(ctx.user.id, teamSlug);
  if (!team) return <NotFoundPage />;

  const db = getDb();
  const rows = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(eq(projects.teamId, team.id));

  return (
    <div className="mx-auto max-w-2xl p-6 sm:p-8">
      <div className="mb-2">
        <a href="/" className="text-muted-foreground text-sm hover:underline">
          &larr; Teams
        </a>
      </div>
      <h1 className="mb-1 font-semibold text-2xl">{team.name}</h1>
      <p className="mb-6 text-muted-foreground">
        Pick a project to view its test runs.
      </p>
      {rows.length === 0 ? (
        <div className="text-muted-foreground">
          <p className="mb-2">No projects yet.</p>
          {team.role === "owner" && (
            <a
              href={`/admin/t/${team.slug}/projects/new`}
              className="text-foreground underline-offset-4 hover:underline"
            >
              Create the first project &rarr;
            </a>
          )}
        </div>
      ) : (
        <ul className="divide-y border-y">
          {rows.map((p) => (
            <li key={p.id}>
              <a
                href={`/t/${team.slug}/p/${p.slug}`}
                className="block py-3 font-semibold hover:bg-accent/32"
              >
                {p.name}
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-8">
        <a
          href={`/admin/t/${team.slug}`}
          className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
        >
          Manage team &rarr;
        </a>
      </div>
    </div>
  );
}
