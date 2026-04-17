import { ulid } from "ulid";
import { requestInfo } from "rwsdk/worker";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { Card, CardPanel } from "@/app/components/ui/card";
import { Field, FieldLabel } from "@/app/components/ui/field";
import { Input } from "@/app/components/ui/input";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { resolveTeamBySlug } from "@/lib/authz";
import { readField } from "@/lib/form";
import { param } from "@/lib/route-params";
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
    <div className="mx-auto max-w-md p-6 sm:p-8">
      <div className="mb-2">
        <a
          href={`/admin/t/${team.slug}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          &larr; {team.name}
        </a>
      </div>
      <h1 className="mb-6 font-semibold text-2xl">
        New project in {team.name}
      </h1>
      <Card>
        <CardPanel className="flex flex-col gap-4">
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form method="post" className="flex flex-col gap-3">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input nativeInput name="name" required maxLength={60} />
            </Field>
            <Field>
              <FieldLabel>Slug</FieldLabel>
              <Input
                nativeInput
                name="slug"
                required
                pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                maxLength={40}
                className="font-mono"
              />
            </Field>
            <Button type="submit" className="mt-2 self-start">
              Create project
            </Button>
          </form>
        </CardPanel>
      </Card>
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
