import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { resolveTeamBySlug } from "@/lib/authz";
import { param } from "@/lib/route-params";
import { NotFoundPage } from "@/app/pages/not-found";
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
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <div style={{ marginBottom: "1rem" }}>
        <a href="/" style={{ color: "#6b7280", textDecoration: "none" }}>
          &larr; Teams
        </a>
      </div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>
        {team.name}
      </h1>
      <p style={{ color: "#6b7280", marginBottom: "1.5rem" }}>
        Pick a project to view its test runs.
      </p>
      {rows.length === 0 ? (
        <div style={{ color: "#6b7280" }}>
          <p>No projects yet.</p>
          {team.role === "owner" && (
            <a
              href={`/admin/t/${team.slug}/projects/new`}
              style={{ color: "#2563eb" }}
            >
              Create the first project &rarr;
            </a>
          )}
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rows.map((p) => (
            <li
              key={p.id}
              style={{
                padding: "0.75rem 0",
                borderBottom: "1px solid #f3f4f6",
              }}
            >
              <a
                href={`/t/${team.slug}/p/${p.slug}`}
                style={{ color: "#111827", textDecoration: "none" }}
              >
                <strong>{p.name}</strong>
              </a>
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: "2rem" }}>
        <a href={`/admin/t/${team.slug}`} style={{ color: "#2563eb" }}>
          Manage team &rarr;
        </a>
      </div>
    </div>
  );
}
