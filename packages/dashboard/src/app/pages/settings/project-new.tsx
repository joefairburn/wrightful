import { ArrowLeft, FolderPlus } from "lucide-react";
import { ulid } from "ulid";
import { requestInfo } from "rwsdk/worker";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/app/components/ui/field";
import { Input } from "@/app/components/ui/input";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { resolveTeamBySlug } from "@/lib/authz";
import { readField } from "@/lib/form";
import { param } from "@/lib/route-params";
import type { AppContext } from "@/worker";

const SLUG_MAX_LEN = 40;

function slugifyName(name: string): string | null {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/, "");
  return base.length >= 1 ? base : null;
}

function pickUniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i <= 999; i++) {
    const suffix = `-${i}`;
    const trimmed = base
      .slice(0, SLUG_MAX_LEN - suffix.length)
      .replace(/-+$/, "");
    const candidate = `${trimmed}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Extremely unlikely — fall back to a random suffix; insert will still
  // reject on collision and the user will see a retry error.
  return `${base.slice(0, SLUG_MAX_LEN - 7).replace(/-+$/, "")}-${ulid().slice(-6).toLowerCase()}`;
}

export async function SettingsProjectNewPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const teamSlug = param("teamSlug");
  const team = await resolveTeamBySlug(ctx.user.id, teamSlug);
  if (!team || team.role !== "owner") return <NotFoundPage />;

  const error = new URL(requestInfo.request.url).searchParams.get("error");

  return (
    <div className="mx-auto w-full max-w-xl p-6 sm:p-8">
      {/* Page header */}
      <div className="mb-6 border-border/50 border-b pb-5">
        <a
          href={`/settings/teams/${team.slug}`}
          className="mb-3 inline-flex items-center gap-1.5 font-mono text-muted-foreground text-xs transition-colors hover:text-foreground"
        >
          <ArrowLeft size={12} strokeWidth={2} />
          {team.name}
        </a>
        <h1 className="font-semibold text-2xl tracking-tight">New project</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Add a project to{" "}
          <span className="font-medium text-foreground">{team.name}</span>. A
          URL slug is generated from the name.
        </p>
      </div>

      {error && (
        <Alert variant="error" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-lg border border-border bg-card">
        <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
          <FolderPlus
            size={14}
            strokeWidth={2}
            className="text-muted-foreground"
          />
          <h2 className="font-semibold text-sm tracking-tight">
            Project details
          </h2>
        </header>
        <form method="post" className="flex flex-col gap-4 p-5">
          <Field>
            <FieldLabel className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              Project name
            </FieldLabel>
            <Input
              nativeInput
              name="name"
              required
              maxLength={60}
              placeholder="e.g. Checkout Flow"
            />
            <FieldDescription className="font-mono text-[11px]">
              Must contain at least one letter or number.
            </FieldDescription>
          </Field>
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit">Create project</Button>
            <a
              href={`/settings/teams/${team.slug}`}
              className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
            >
              Cancel
            </a>
          </div>
        </form>
      </section>
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
  const origin = new URL(request.url).origin;
  const formUrl = `${origin}/settings/teams/${team.slug}/projects/new`;

  if (!name) {
    return Response.redirect(
      `${formUrl}?error=${encodeURIComponent("Name is required.")}`,
      302,
    );
  }

  const baseSlug = slugifyName(name);
  if (!baseSlug) {
    return Response.redirect(
      `${formUrl}?error=${encodeURIComponent(
        "Name must contain at least one letter or number.",
      )}`,
      302,
    );
  }

  const db = getDb();
  const takenSlugs = new Set(
    (
      await db
        .selectFrom("projects")
        .select("slug")
        .where("teamId", "=", team.id)
        .execute()
    ).map((r) => r.slug),
  );
  const slug = pickUniqueSlug(baseSlug, takenSlugs);

  try {
    await db
      .insertInto("projects")
      .values({
        id: ulid(),
        teamId: team.id,
        slug,
        name,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .execute();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const friendly = msg.includes("UNIQUE")
      ? "Could not create project — please try again."
      : "Could not create project.";
    return Response.redirect(
      `${formUrl}?error=${encodeURIComponent(friendly)}`,
      302,
    );
  }

  return Response.redirect(`${origin}/settings/teams/${team.slug}`, 302);
}
