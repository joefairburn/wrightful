import { ulid } from "ulid";
import { requestInfo } from "rwsdk/worker";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { Card, CardPanel } from "@/app/components/ui/card";
import { Field, FieldLabel } from "@/app/components/ui/field";
import { Input } from "@/app/components/ui/input";
import { getDb } from "@/db";
import { memberships, teams } from "@/db/schema";
import { readField } from "@/lib/form";
import type { AppContext } from "@/worker";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function AdminTeamNewPage() {
  const url = new URL(requestInfo.request.url);
  const error = url.searchParams.get("error");
  return (
    <div className="mx-auto max-w-md p-6 sm:p-8">
      <div className="mb-2">
        <a
          href="/admin/teams"
          className="text-muted-foreground text-sm hover:underline"
        >
          &larr; Teams
        </a>
      </div>
      <h1 className="mb-6 font-semibold text-2xl">Create a team</h1>
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
              <FieldLabel>Slug (lowercase, used in URLs)</FieldLabel>
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
              Create team
            </Button>
          </form>
        </CardPanel>
      </Card>
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
