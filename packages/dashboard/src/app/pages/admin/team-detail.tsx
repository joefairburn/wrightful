import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { getDb } from "@/db";
import { memberships, projects, user } from "@/db/schema";
import { resolveTeamBySlug } from "@/lib/authz";
import { param } from "@/lib/route-params";
import { NotFoundPage } from "@/app/pages/not-found";
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
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <div style={{ marginBottom: "1rem" }}>
        <a
          href="/admin/teams"
          style={{ color: "#6b7280", textDecoration: "none" }}
        >
          &larr; Teams
        </a>
      </div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>
        {team.name}
      </h1>

      <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>Projects</h2>
      {projectRows.length === 0 ? (
        <p style={{ color: "#6b7280" }}>No projects yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {projectRows.map((p) => (
            <li
              key={p.id}
              style={{
                padding: "0.5rem 0",
                borderBottom: "1px solid #f3f4f6",
                display: "flex",
                gap: "1rem",
                alignItems: "center",
              }}
            >
              <strong style={{ flex: 1 }}>{p.name}</strong>
              <a
                href={`/t/${team.slug}/p/${p.slug}`}
                style={{ color: "#2563eb", textDecoration: "none" }}
              >
                Runs
              </a>
              {team.role === "owner" && (
                <a
                  href={`/admin/t/${team.slug}/p/${p.slug}/keys`}
                  style={{ color: "#2563eb", textDecoration: "none" }}
                >
                  API keys
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {team.role === "owner" && (
        <a
          href={`/admin/t/${team.slug}/projects/new`}
          style={{
            display: "inline-block",
            marginTop: "1rem",
            padding: "0.5rem 1rem",
            background: "#111827",
            color: "#fff",
            textDecoration: "none",
            borderRadius: "6px",
          }}
        >
          Create project
        </a>
      )}

      <h2
        style={{
          fontSize: "1.1rem",
          marginTop: "2rem",
          marginBottom: "0.5rem",
        }}
      >
        Members
      </h2>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {memberRows.map((m) => (
          <li
            key={m.userId}
            style={{
              padding: "0.5rem 0",
              borderBottom: "1px solid #f3f4f6",
              display: "flex",
              gap: "1rem",
            }}
          >
            <span style={{ flex: 1 }}>
              {m.name} <span style={{ color: "#6b7280" }}>({m.email})</span>
            </span>
            <span style={{ color: "#6b7280" }}>{m.role}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
