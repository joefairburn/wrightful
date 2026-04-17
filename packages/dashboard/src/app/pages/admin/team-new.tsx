import { ulid } from "ulid";
import { requestInfo } from "rwsdk/worker";
import { getDb } from "@/db";
import { memberships, teams } from "@/db/schema";
import { readField } from "@/lib/form";
import type { AppContext } from "@/worker";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function AdminTeamNewPage() {
  const url = new URL(requestInfo.request.url);
  const error = url.searchParams.get("error");
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        maxWidth: 480,
      }}
    >
      <div style={{ marginBottom: "1rem" }}>
        <a
          href="/admin/teams"
          style={{ color: "#6b7280", textDecoration: "none" }}
        >
          &larr; Teams
        </a>
      </div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
        Create a team
      </h1>
      {error && (
        <p
          style={{
            color: "#991b1b",
            background: "#fef2f2",
            padding: "0.5rem 0.75rem",
            borderRadius: "4px",
            marginBottom: "1rem",
          }}
        >
          {error}
        </p>
      )}
      <form method="post" style={{ display: "grid", gap: "0.75rem" }}>
        <label>
          <span style={{ display: "block", fontSize: "0.85rem" }}>Name</span>
          <input
            name="name"
            required
            maxLength={60}
            style={{ padding: "0.5rem", width: "100%" }}
          />
        </label>
        <label>
          <span style={{ display: "block", fontSize: "0.85rem" }}>
            Slug (lowercase, used in URLs)
          </span>
          <input
            name="slug"
            required
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
            maxLength={40}
            style={{
              padding: "0.5rem",
              width: "100%",
              fontFamily: "monospace",
            }}
          />
        </label>
        <button
          type="submit"
          style={{
            padding: "0.5rem 1rem",
            background: "#111827",
            color: "#fff",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
          }}
        >
          Create team
        </button>
      </form>
    </div>
  );
}

export async function createTeamHandler({
  request,
  ctx,
}: {
  request: Request;
  ctx: AppContext;
}) {
  if (!ctx.user) {
    return new Response(null, { status: 401 });
  }

  const form = await request.formData();
  const name = readField(form, "name").trim();
  const slug = readField(form, "slug").trim().toLowerCase();

  if (!name || !SLUG_RE.test(slug)) {
    return Response.redirect(
      `${new URL(request.url).origin}/admin/teams/new?error=${encodeURIComponent(
        "Name is required and slug must be lowercase alphanumerics with hyphens.",
      )}`,
      302,
    );
  }

  const db = getDb();
  const teamId = ulid();
  try {
    await db.batch([
      db.insert(teams).values({
        id: teamId,
        slug,
        name,
        createdAt: new Date(),
      }),
      db.insert(memberships).values({
        id: ulid(),
        userId: ctx.user.id,
        teamId,
        role: "owner",
        createdAt: new Date(),
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const friendly = msg.includes("UNIQUE")
      ? "That slug is already taken."
      : "Could not create team.";
    return Response.redirect(
      `${new URL(request.url).origin}/admin/teams/new?error=${encodeURIComponent(friendly)}`,
      302,
    );
  }

  return Response.redirect(
    `${new URL(request.url).origin}/admin/t/${slug}`,
    302,
  );
}
