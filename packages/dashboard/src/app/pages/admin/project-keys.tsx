import { and, desc, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { requestInfo } from "rwsdk/worker";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { resolveProjectBySlugs } from "@/lib/authz";
import { param } from "@/lib/route-params";
import { readField } from "@/lib/form";
import { NotFoundPage } from "@/app/pages/not-found";
import type { AppContext } from "@/worker";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateApiKey(): string {
  const rand = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...rand))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `wrf_${b64}`;
}

export async function AdminProjectKeysPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const teamSlug = param("teamSlug");
  const projectSlug = param("projectSlug");
  const project = await resolveProjectBySlugs(
    ctx.user.id,
    teamSlug,
    projectSlug,
  );
  if (!project || project.role !== "owner") return <NotFoundPage />;

  const url = new URL(requestInfo.request.url);
  const revealedKey = url.searchParams.get("key");

  const db = getDb();
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.projectId, project.id))
    .orderBy(desc(apiKeys.createdAt));

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <div style={{ marginBottom: "1rem" }}>
        <a
          href={`/admin/t/${project.teamSlug}`}
          style={{ color: "#6b7280", textDecoration: "none" }}
        >
          &larr; {project.teamSlug}
        </a>
      </div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
        API keys — {project.name}
      </h1>
      <p style={{ color: "#6b7280", marginBottom: "1.5rem" }}>
        Keys authorise the CLI to upload Playwright reports into this project.
      </p>

      {revealedKey && (
        <div
          style={{
            padding: "1rem",
            background: "#ecfdf5",
            borderRadius: "6px",
            marginBottom: "1.5rem",
          }}
        >
          <p style={{ fontWeight: 600, margin: 0, color: "#065f46" }}>
            Copy your new key now — it won&apos;t be shown again.
          </p>
          <pre
            style={{
              marginTop: "0.5rem",
              padding: "0.5rem",
              background: "#fff",
              borderRadius: "4px",
              fontFamily: "monospace",
              overflowX: "auto",
            }}
          >
            {revealedKey}
          </pre>
        </div>
      )}

      <form
        method="post"
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "end",
          marginBottom: "1.5rem",
        }}
      >
        <input type="hidden" name="action" value="create" />
        <label style={{ flex: 1 }}>
          <span style={{ display: "block", fontSize: "0.85rem" }}>Label</span>
          <input
            name="label"
            required
            maxLength={60}
            placeholder="e.g. CI main"
            style={{ padding: "0.5rem", width: "100%" }}
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
          Mint key
        </button>
      </form>

      {rows.length === 0 ? (
        <p style={{ color: "#6b7280" }}>No keys yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr
              style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}
            >
              <th style={{ padding: "0.5rem" }}>Label</th>
              <th style={{ padding: "0.5rem" }}>Prefix</th>
              <th style={{ padding: "0.5rem" }}>Created</th>
              <th style={{ padding: "0.5rem" }}>Last used</th>
              <th style={{ padding: "0.5rem" }}>Status</th>
              <th style={{ padding: "0.5rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ padding: "0.5rem" }}>{k.label}</td>
                <td
                  style={{
                    padding: "0.5rem",
                    fontFamily: "monospace",
                    fontSize: "0.85rem",
                  }}
                >
                  {k.keyPrefix}…
                </td>
                <td style={{ padding: "0.5rem", color: "#6b7280" }}>
                  {k.createdAt.toISOString().slice(0, 10)}
                </td>
                <td style={{ padding: "0.5rem", color: "#6b7280" }}>
                  {k.lastUsedAt?.toISOString().slice(0, 10) ?? "—"}
                </td>
                <td style={{ padding: "0.5rem" }}>
                  {k.revokedAt ? (
                    <span style={{ color: "#dc2626" }}>revoked</span>
                  ) : (
                    <span style={{ color: "#16a34a" }}>active</span>
                  )}
                </td>
                <td style={{ padding: "0.5rem" }}>
                  {!k.revokedAt && (
                    <form method="post" style={{ margin: 0 }}>
                      <input type="hidden" name="action" value="revoke" />
                      <input type="hidden" name="keyId" value={k.id} />
                      <button
                        type="submit"
                        style={{
                          background: "none",
                          border: "none",
                          color: "#dc2626",
                          cursor: "pointer",
                        }}
                      >
                        Revoke
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export async function projectKeysHandler({
  request,
  ctx,
  params,
}: {
  request: Request;
  ctx: AppContext;
  params: Record<string, string>;
}) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const project = await resolveProjectBySlugs(
    ctx.user.id,
    params.teamSlug,
    params.projectSlug,
  );
  if (!project || project.role !== "owner") {
    return new Response("Not found", { status: 404 });
  }

  const form = await request.formData();
  const action = readField(form, "action");
  const origin = new URL(request.url).origin;
  const back = `${origin}/admin/t/${project.teamSlug}/p/${project.slug}/keys`;

  const db = getDb();

  if (action === "create") {
    const label = readField(form, "label").trim();
    if (!label) return Response.redirect(back, 302);
    const rawKey = generateApiKey();
    await db.insert(apiKeys).values({
      id: ulid(),
      projectId: project.id,
      label,
      keyHash: await sha256Hex(rawKey),
      keyPrefix: rawKey.slice(0, 8),
      createdAt: new Date(),
    });
    return Response.redirect(`${back}?key=${encodeURIComponent(rawKey)}`, 302);
  }

  if (action === "revoke") {
    const keyId = readField(form, "keyId");
    if (!keyId) return Response.redirect(back, 302);
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.projectId, project.id),
          isNull(apiKeys.revokedAt),
        ),
      );
    return Response.redirect(back, 302);
  }

  return Response.redirect(back, 302);
}
