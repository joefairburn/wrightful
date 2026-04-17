import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { getDb } from "@/db";
import { memberships, teams } from "@/db/schema";
import { NotFoundPage } from "@/app/pages/not-found";
import type { AppContext } from "@/worker";

export async function TeamPickerPage() {
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

  if (rows.length === 1) {
    return Response.redirect(
      `${new URL(requestInfo.request.url).origin}/t/${rows[0].slug}`,
      302,
    );
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Your teams</h1>
      {rows.length === 0 ? (
        <div style={{ color: "#6b7280" }}>
          <p>
            You&apos;re not a member of any team yet. Create one to start
            collecting Playwright runs.
          </p>
          <a
            href="/admin/teams/new"
            style={{
              display: "inline-block",
              marginTop: "0.75rem",
              padding: "0.5rem 1rem",
              background: "#111827",
              color: "#fff",
              textDecoration: "none",
              borderRadius: "6px",
            }}
          >
            Create a team
          </a>
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rows.map((t) => (
            <li
              key={t.id}
              style={{
                padding: "0.75rem 0",
                borderBottom: "1px solid #f3f4f6",
              }}
            >
              <a
                href={`/t/${t.slug}`}
                style={{ color: "#111827", textDecoration: "none" }}
              >
                <strong>{t.name}</strong>
                <span
                  style={{
                    marginLeft: "0.5rem",
                    color: "#6b7280",
                    fontSize: "0.85rem",
                  }}
                >
                  {t.role}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: "2rem" }}>
        <a href="/admin/teams" style={{ color: "#2563eb" }}>
          Manage teams &rarr;
        </a>
      </div>
    </div>
  );
}
