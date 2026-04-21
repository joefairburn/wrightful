import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowLeft,
  FolderCog,
  KeyRound,
  Plus,
} from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import { ulid } from "ulid";
import { Alert, AlertDescription, AlertTitle } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/app/components/ui/field";
import { Input } from "@/app/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { batchD1 } from "@/db/batch";
import { resolveProjectBySlugs } from "@/lib/authz";
import { cn } from "@/lib/cn";
import { readField } from "@/lib/form";
import { param } from "@/lib/route-params";
import type { AppContext } from "@/worker";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

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

const REVEAL_COOKIE = "wrightful_reveal_key";

function readRevealCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === REVEAL_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function revealCookie(
  teamSlug: string,
  projectSlug: string,
  value: string | null,
): string {
  const path = `/settings/teams/${teamSlug}/p/${projectSlug}/keys`;
  const base = `${REVEAL_COOKIE}=${value ? encodeURIComponent(value) : ""}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
  return value ? `${base}; Max-Age=60` : `${base}; Max-Age=0`;
}

function redirectWithParam(base: string, key: string, value: string): Response {
  const url = new URL(base);
  url.searchParams.set(key, value);
  return Response.redirect(url.toString(), 302);
}

export async function SettingsProjectKeysPage() {
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
  const generalError = url.searchParams.get("generalError");
  const dangerError = url.searchParams.get("dangerError");

  const revealedKey = readRevealCookie(requestInfo.request);
  if (revealedKey) {
    requestInfo.response.headers.append(
      "Set-Cookie",
      revealCookie(project.teamSlug, project.slug, null),
    );
  }

  const db = getDb();
  const rows = await db
    .selectFrom("apiKeys")
    .selectAll()
    .where("projectId", "=", project.id)
    .orderBy("createdAt", "desc")
    .execute();

  return (
    <div className="mx-auto w-full max-w-5xl p-6 sm:p-8">
      {/* Page header */}
      <div className="mb-6 border-border/50 border-b pb-5">
        <a
          href={`/settings/teams/${project.teamSlug}`}
          className="mb-3 inline-flex items-center gap-1.5 font-mono text-muted-foreground text-xs transition-colors hover:text-foreground"
        >
          <ArrowLeft size={12} strokeWidth={2} />
          Team
        </a>
        <h1 className="font-semibold text-2xl tracking-tight">
          Project settings
        </h1>
        <p className="mt-1 flex items-center gap-2 font-mono text-muted-foreground text-xs">
          <span className="text-muted-foreground/70">project:</span>
          <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
            {project.name}
          </span>
        </p>
      </div>

      {revealedKey && (
        <Alert variant="success" className="mb-6">
          <AlertTitle>
            Copy your new key now — it won&apos;t be shown again.
          </AlertTitle>
          <AlertDescription>
            <pre className="overflow-x-auto rounded-md bg-background p-2 font-mono text-xs">
              {revealedKey}
            </pre>
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-6">
        {/* Project details */}
        <section className="rounded-lg border border-border bg-card">
          <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
            <FolderCog
              size={14}
              strokeWidth={2}
              className="text-muted-foreground"
            />
            <h2 className="font-semibold text-sm tracking-tight">
              Project details
            </h2>
          </header>
          <form method="post" className="flex flex-col gap-4 p-5">
            <input type="hidden" name="action" value="update-general" />
            {generalError && (
              <Alert variant="error">
                <AlertDescription>{generalError}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                Project name
              </FieldLabel>
              <Input
                nativeInput
                name="name"
                required
                maxLength={60}
                defaultValue={project.name}
              />
            </Field>
            <Field>
              <FieldLabel className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                URL slug
              </FieldLabel>
              <Input
                nativeInput
                name="slug"
                required
                pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
                maxLength={40}
                defaultValue={project.slug}
                className="font-mono"
              />
              <FieldDescription className="font-mono text-[11px]">
                Changing the slug will change the URL of this project.
              </FieldDescription>
            </Field>
            <div className="flex items-center gap-3 pt-1">
              <Button type="submit" size="sm">
                Save changes
              </Button>
              <a
                href={`/settings/teams/${project.teamSlug}/p/${project.slug}/keys`}
                className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
              >
                Discard
              </a>
            </div>
          </form>
        </section>

        {/* Mint key */}
        <section className="rounded-lg border border-border bg-card">
          <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
            <Plus size={14} strokeWidth={2} className="text-muted-foreground" />
            <h2 className="font-semibold text-sm tracking-tight">
              Mint a new key
            </h2>
          </header>
          <form method="post" className="flex items-end gap-3 p-5">
            <input type="hidden" name="action" value="create" />
            <Field className="flex-1">
              <FieldLabel className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                Label
              </FieldLabel>
              <Input
                nativeInput
                name="label"
                required
                maxLength={60}
                placeholder="e.g. CI main"
              />
            </Field>
            <Button type="submit">Mint key</Button>
          </form>
        </section>

        {/* Keys list */}
        <section className="rounded-lg border border-border bg-card">
          <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
            <KeyRound
              size={14}
              strokeWidth={2}
              className="text-muted-foreground"
            />
            <h2 className="font-semibold text-sm tracking-tight">Keys</h2>
            <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
              {rows.length}
            </span>
          </header>
          {rows.length === 0 ? (
            <div className="px-5 py-8 text-center text-muted-foreground text-sm">
              No keys yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
                  <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Label
                  </TableHead>
                  <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Prefix
                  </TableHead>
                  <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Created
                  </TableHead>
                  <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Last used
                  </TableHead>
                  <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Status
                  </TableHead>
                  <TableHead className="px-5 py-2.5" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((k) => {
                  const revoked = Boolean(k.revokedAt);
                  return (
                    <TableRow
                      key={k.id}
                      className="border-border/50 border-b last:border-b-0"
                    >
                      <TableCell className="px-5 py-3 font-medium text-sm">
                        {k.label}
                      </TableCell>
                      <TableCell className="px-5 py-3 font-mono text-muted-foreground text-xs">
                        {k.keyPrefix}…
                      </TableCell>
                      <TableCell className="px-5 py-3 font-mono text-muted-foreground text-xs tabular-nums">
                        {format(new Date(k.createdAt * 1000), "yyyy-MM-dd")}
                      </TableCell>
                      <TableCell className="px-5 py-3 font-mono text-muted-foreground text-xs tabular-nums">
                        {k.lastUsedAt
                          ? format(new Date(k.lastUsedAt * 1000), "yyyy-MM-dd")
                          : "—"}
                      </TableCell>
                      <TableCell className="px-5 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                            revoked
                              ? "border-destructive/20 bg-destructive/8 text-destructive-foreground"
                              : "border-success/24 bg-success/8 text-success-foreground",
                          )}
                        >
                          <span
                            className={cn(
                              "inline-block size-1.5 rounded-full",
                              revoked
                                ? "bg-destructive"
                                : "bg-success shadow-[0_0_6px_var(--color-success)]",
                            )}
                          />
                          {revoked ? "revoked" : "active"}
                        </span>
                      </TableCell>
                      <TableCell className="px-5 py-3 text-right">
                        {!revoked && (
                          <form method="post" className="m-0 inline-flex">
                            <input type="hidden" name="action" value="revoke" />
                            <input type="hidden" name="keyId" value={k.id} />
                            <button
                              type="submit"
                              className="inline-flex h-7 cursor-pointer items-center justify-center rounded-sm border border-destructive/32 bg-background px-2.5 font-mono text-[10px] text-destructive-foreground uppercase tracking-wider transition-colors hover:bg-destructive/8"
                            >
                              Revoke
                            </button>
                          </form>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </section>

        {/* Danger zone */}
        <section className="rounded-lg border border-destructive/24 bg-card">
          <header className="flex items-center gap-2 border-destructive/20 border-b px-5 py-3">
            <AlertTriangle
              size={14}
              strokeWidth={2}
              className="text-destructive-foreground"
            />
            <h2 className="font-semibold text-destructive-foreground text-sm tracking-tight">
              Danger zone
            </h2>
          </header>
          <div className="flex flex-col gap-3 p-5">
            <p className="text-muted-foreground text-xs leading-relaxed">
              Permanently delete this project, its API keys, and all run
              history. This cannot be undone.
            </p>
            <details className="group">
              <summary className="inline-flex h-8 cursor-pointer list-none items-center justify-center self-start rounded-md border border-destructive/32 bg-background px-3 font-mono font-medium text-[11px] text-destructive-foreground uppercase tracking-wider transition-colors hover:bg-destructive/8 [&::-webkit-details-marker]:hidden">
                Delete project
              </summary>
              <form
                method="post"
                className="mt-4 flex flex-col gap-3 border-destructive/20 border-t pt-4"
              >
                <input type="hidden" name="action" value="delete" />
                {dangerError && (
                  <Alert variant="error">
                    <AlertDescription>{dangerError}</AlertDescription>
                  </Alert>
                )}
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Type{" "}
                  <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                    {project.slug}
                  </code>{" "}
                  below to confirm.
                </p>
                <Input
                  nativeInput
                  name="confirm"
                  required
                  autoComplete="off"
                  placeholder={project.slug}
                  className="font-mono"
                />
                <button
                  type="submit"
                  className="inline-flex h-8 cursor-pointer items-center justify-center self-start rounded-md border border-destructive bg-destructive px-3 font-mono font-medium text-[11px] text-white uppercase tracking-wider transition-colors hover:bg-destructive/90"
                >
                  Permanently delete
                </button>
              </form>
            </details>
          </div>
        </section>
      </div>
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
  const here = `${origin}/settings/teams/${project.teamSlug}/p/${project.slug}/keys`;

  const db = getDb();

  if (action === "create") {
    const label = readField(form, "label").trim();
    if (!label) return Response.redirect(here, 302);
    const rawKey = generateApiKey();
    await db
      .insertInto("apiKeys")
      .values({
        id: ulid(),
        projectId: project.id,
        label,
        keyHash: await sha256Hex(rawKey),
        keyPrefix: rawKey.slice(0, 8),
        createdAt: Math.floor(Date.now() / 1000),
        lastUsedAt: null,
        revokedAt: null,
      })
      .execute();
    return new Response(null, {
      status: 302,
      headers: {
        Location: here,
        "Set-Cookie": revealCookie(project.teamSlug, project.slug, rawKey),
      },
    });
  }

  if (action === "revoke") {
    const keyId = readField(form, "keyId");
    if (!keyId) return Response.redirect(here, 302);
    await db
      .updateTable("apiKeys")
      .set({ revokedAt: Math.floor(Date.now() / 1000) })
      .where("id", "=", keyId)
      .where("projectId", "=", project.id)
      .where("revokedAt", "is", null)
      .execute();
    return Response.redirect(here, 302);
  }

  if (action === "update-general") {
    const name = readField(form, "name").trim();
    const slug = readField(form, "slug").trim().toLowerCase();

    if (!name) {
      return redirectWithParam(here, "generalError", "Name is required.");
    }
    if (!SLUG_RE.test(slug)) {
      return redirectWithParam(
        here,
        "generalError",
        "Slug must be 1–40 lowercase alphanumerics and hyphens, starting and ending with a letter or number.",
      );
    }

    if (slug !== project.slug) {
      const clash = await db
        .selectFrom("projects")
        .select("id")
        .where("teamId", "=", project.teamId)
        .where("slug", "=", slug)
        .where("id", "!=", project.id)
        .limit(1)
        .executeTakeFirst();
      if (clash) {
        return redirectWithParam(
          here,
          "generalError",
          "That slug is already used by another project in this team.",
        );
      }
    }

    try {
      await db
        .updateTable("projects")
        .set({ name, slug })
        .where("id", "=", project.id)
        .execute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const friendly = msg.includes("UNIQUE")
        ? "That slug is already used by another project in this team."
        : "Could not save changes.";
      return redirectWithParam(here, "generalError", friendly);
    }

    return Response.redirect(
      `${origin}/settings/teams/${project.teamSlug}/p/${slug}/keys`,
      302,
    );
  }

  if (action === "delete") {
    const confirm = readField(form, "confirm").trim();
    if (confirm !== project.slug) {
      return redirectWithParam(
        here,
        "dangerError",
        `Confirmation did not match. Type "${project.slug}" exactly to delete the project.`,
      );
    }

    try {
      await batchD1([
        db.deleteFrom("apiKeys").where("projectId", "=", project.id),
        db
          .updateTable("userState")
          .set({ lastProjectId: null })
          .where("lastProjectId", "=", project.id),
        db.deleteFrom("projects").where("id", "=", project.id),
      ]);
    } catch {
      return redirectWithParam(
        here,
        "dangerError",
        "Could not delete project — please try again.",
      );
    }

    return Response.redirect(
      `${origin}/settings/teams/${project.teamSlug}`,
      302,
    );
  }

  return Response.redirect(here, 302);
}
