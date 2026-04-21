import { requestInfo } from "rwsdk/worker";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
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
  const firstProject = await db
    .selectFrom("projects")
    .select("slug")
    .where("teamId", "=", team.id)
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirst();

  if (firstProject) {
    const origin = new URL(requestInfo.request.url).origin;
    return Response.redirect(
      `${origin}/t/${team.slug}/p/${firstProject.slug}`,
      302,
    );
  }

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
      <div className="text-muted-foreground">
        <p className="mb-2">No projects yet.</p>
        {team.role === "owner" && (
          <a
            href={`/settings/teams/${team.slug}/projects/new`}
            className="text-foreground underline-offset-4 hover:underline"
          >
            Create the first project &rarr;
          </a>
        )}
      </div>
      <div className="mt-8">
        <a
          href={`/settings/teams/${team.slug}`}
          className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
        >
          Manage team &rarr;
        </a>
      </div>
    </div>
  );
}
