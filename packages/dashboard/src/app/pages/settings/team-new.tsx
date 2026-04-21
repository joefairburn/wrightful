import { Users } from "lucide-react";
import { ulid } from "ulid";
import { requestInfo } from "rwsdk/worker";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/app/components/ui/field";
import { Input } from "@/app/components/ui/input";
import { getDb } from "@/db";
import { batchD1 } from "@/db/batch";
import { readField } from "@/lib/form";
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
  return `${base.slice(0, SLUG_MAX_LEN - 7).replace(/-+$/, "")}-${ulid().slice(-6).toLowerCase()}`;
}

export function SettingsTeamNewPage() {
  const url = new URL(requestInfo.request.url);
  const error = url.searchParams.get("error");
  return (
    <div className="mx-auto w-full max-w-xl p-6 sm:p-8">
      {/* Page header */}
      <div className="mb-6 border-border/50 border-b pb-5">
        <h1 className="font-semibold text-2xl tracking-tight">Create a team</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Teams group projects and teammates together. A URL slug is generated
          from the name.
        </p>
      </div>

      {error && (
        <Alert variant="error" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-lg border border-border bg-card">
        <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
          <Users size={14} strokeWidth={2} className="text-muted-foreground" />
          <h2 className="font-semibold text-sm tracking-tight">Team details</h2>
        </header>
        <form method="post" className="flex flex-col gap-4 p-5">
          <Field>
            <FieldLabel className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              Team name
            </FieldLabel>
            <Input
              nativeInput
              name="name"
              required
              maxLength={60}
              placeholder="e.g. Platform Engineering"
            />
            <FieldDescription className="font-mono text-[11px]">
              Must contain at least one letter or number.
            </FieldDescription>
          </Field>
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit">Create team</Button>
            <a
              href="/settings"
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
  const origin = new URL(request.url).origin;
  const formUrl = `${origin}/settings/teams/new`;

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
  const existingRows = await db
    .selectFrom("teams")
    .select("slug")
    .where((eb) =>
      eb.or([eb("slug", "=", baseSlug), eb("slug", "like", `${baseSlug}-%`)]),
    )
    .execute();
  const taken = new Set(existingRows.map((r) => r.slug));
  const slug = pickUniqueSlug(baseSlug, taken);

  const teamId = ulid();
  const nowSeconds = Math.floor(Date.now() / 1000);
  try {
    await batchD1([
      db.insertInto("teams").values({
        id: teamId,
        slug,
        name,
        createdAt: nowSeconds,
        lastActivityAt: null,
      }),
      db.insertInto("memberships").values({
        id: ulid(),
        userId: ctx.user.id,
        teamId,
        role: "owner",
        createdAt: nowSeconds,
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const friendly = msg.includes("UNIQUE")
      ? "Could not create team — please try again."
      : "Could not create team.";
    return Response.redirect(
      `${formUrl}?error=${encodeURIComponent(friendly)}`,
      302,
    );
  }

  return Response.redirect(`${origin}/settings/teams/${slug}`, 302);
}
