import { ulid } from "ulid";
import { requestInfo } from "rwsdk/worker";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { resolveTeamBySlug } from "@/lib/authz";
import { param } from "@/lib/route-params";
import { readField } from "@/lib/form";
import { NotFoundPage } from "@/app/pages/not-found";
import type { AppContext } from "@/worker";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export async function AdminProjectNewPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const teamSlug = param("teamSlug");
  const team = await resolveTeamBySlug(ctx.user.id, teamSlug);
  if (!team || team.role !== "owner") return <NotFoundPage />;

  const error = new URL(requestInfo.request.url).searchParams.get("error");

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
          href={`/admin/t/${team.slug}`}
          style={{ color: "#6b7280", textDecoration: "none" }}
        >
          &larr; {team.name}
        </a>
      </div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
        New project in {team.name}
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
          <span style={{ display: "block", fontSize: "0.85rem" }}>Slug</span>
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
          Create project
        </button>
      </form>
    </div>
  );
}

export async function createProjectHandler({
  request,
  ctx,
  params,
}: {
  request: Request;
  ctx: AppContext;
  params: Record<string, string>;
}) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const teamSlug = params.teamSlug;
  const team = await resolveTeamBySlug(ctx.user.id, teamSlug);
  if (!team || team.role !== "owner") {
    return new Response("Not found", { status: 404 });
  }

  const form = await request.formData();
  const name = readField(form, "name").trim();
  const slug = readField(form, "slug").trim().toLowerCase();
  if (!name || !SLUG_RE.test(slug)) {
    return Response.redirect(
      `${new URL(request.url).origin}/admin/t/${team.slug}/projects/new?error=${encodeURIComponent(
        "Name is required and slug must be lowercase alphanumerics.",
      )}`,
      302,
    );
  }

  const db = getDb();
  try {
    await db.insert(projects).values({
      id: ulid(),
      teamId: team.id,
      slug,
      name,
      createdAt: new Date(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const friendly = msg.includes("UNIQUE")
      ? "That slug is already used in this team."
      : "Could not create project.";
    return Response.redirect(
      `${new URL(request.url).origin}/admin/t/${team.slug}/projects/new?error=${encodeURIComponent(friendly)}`,
      302,
    );
  }

  return Response.redirect(
    `${new URL(request.url).origin}/admin/t/${team.slug}`,
    302,
  );
}
