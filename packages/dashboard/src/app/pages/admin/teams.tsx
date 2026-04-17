import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { getDb } from "@/db";
import { memberships, teams } from "@/db/schema";
import { NotFoundPage } from "@/app/pages/not-found";
import type { AppContext } from "@/worker";

export async function AdminTeamsPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const db = getDb();
  const rows = await db
    .select({
      id: teams.id,
      slug: teams.slug,
      name: teams.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(teams, eq(teams.id, memberships.teamId))
    .where(eq(memberships.userId, ctx.user.id));

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Teams</h1>
      {rows.length === 0 ? (
        <p style={{ color: "#6b7280" }}>You&apos;re not on any team yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr
              style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}
            >
              <th style={{ padding: "0.5rem" }}>Name</th>
              <th style={{ padding: "0.5rem" }}>Slug</th>
              <th style={{ padding: "0.5rem" }}>Role</th>
              <th style={{ padding: "0.5rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ padding: "0.5rem" }}>{t.name}</td>
                <td
                  style={{
                    padding: "0.5rem",
                    fontFamily: "monospace",
                    fontSize: "0.85rem",
                  }}
                >
                  {t.slug}
                </td>
                <td style={{ padding: "0.5rem" }}>{t.role}</td>
                <td style={{ padding: "0.5rem" }}>
                  <a
                    href={`/admin/t/${t.slug}`}
                    style={{ color: "#2563eb", textDecoration: "none" }}
                  >
                    Manage &rarr;
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <a
        href="/admin/teams/new"
        style={{
          display: "inline-block",
          marginTop: "1.5rem",
          padding: "0.5rem 1rem",
          background: "#111827",
          color: "#fff",
          textDecoration: "none",
          borderRadius: "6px",
        }}
      >
        Create team
      </a>
    </div>
  );
}
