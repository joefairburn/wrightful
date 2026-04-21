import type { Compilable } from "kysely";
import {
  AlertTriangle,
  FolderTree,
  Link as LinkIcon,
  Plus,
  Settings,
  Settings2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import { ulid } from "ulid";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
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
import { resolveTeamBySlug } from "@/lib/authz";
import { cn } from "@/lib/cn";
import { readField } from "@/lib/form";
import { param } from "@/lib/route-params";
import { formatRelativeTime } from "@/lib/time-format";
import type { AppContext } from "@/worker";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

function formatExpiresIn(
  expiresAt: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const remaining = expiresAt - nowSec;
  if (remaining <= 0) return "expired";
  const days = Math.floor(remaining / 86400);
  if (days >= 1) return `expires in ${days}d`;
  const hours = Math.floor(remaining / 3600);
  if (hours >= 1) return `expires in ${hours}h`;
  return "expires in <1h";
}

function generateInviteToken(): string {
  const rand = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...rand))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

export async function SettingsTeamDetailPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const teamSlug = param("teamSlug");
  const team = await resolveTeamBySlug(ctx.user.id, teamSlug);
  if (!team) return <NotFoundPage />;

  const url = new URL(requestInfo.request.url);
  const generalError = url.searchParams.get("generalError");
  const dangerError = url.searchParams.get("dangerError");
  const inviteError = url.searchParams.get("inviteError");
  const showInviteToken = url.searchParams.get("showInvite");

  const db = getDb();
  const [memberRows, projectRows, inviteRows] = await Promise.all([
    db
      .selectFrom("memberships")
      .innerJoin("user", "user.id", "memberships.userId")
      .select([
        "memberships.userId as userId",
        "memberships.role as role",
        "user.email as email",
        "user.name as name",
      ])
      .where("memberships.teamId", "=", team.id)
      .execute(),
    db
      .selectFrom("projects")
      .select(["id", "slug", "name"])
      .where("teamId", "=", team.id)
      .orderBy("createdAt", "desc")
      .execute(),
    db
      .selectFrom("teamInvites")
      .select(["id", "token", "role", "createdAt", "expiresAt"])
      .where("teamId", "=", team.id)
      .where("expiresAt", ">", Math.floor(Date.now() / 1000))
      .orderBy("createdAt", "desc")
      .execute(),
  ]);

  const isOwner = team.role === "owner";
  const teamHref = `/settings/teams/${team.slug}`;
  const shownInvite = showInviteToken
    ? inviteRows.find((i) => i.token === showInviteToken)
    : null;
  const shownInviteUrl = shownInvite
    ? `${url.origin}/invite/${shownInvite.token}`
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl p-6 sm:p-8">
      {/* Page header */}
      <div className="mb-6 flex items-end justify-between gap-4 border-border/50 border-b pb-5">
        <div className="min-w-0">
          <h1 className="truncate font-semibold text-2xl tracking-tight">
            {team.name}
          </h1>
          <p className="mt-1 flex items-center gap-2 font-mono text-muted-foreground text-xs">
            <span className="text-muted-foreground/70">team_id:</span>
            <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
              {team.id}
            </span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-6 lg:col-span-1">
          {/* General configuration */}
          <section className="rounded-lg border border-border bg-card">
            <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
              <Settings
                size={14}
                strokeWidth={2}
                className="text-muted-foreground"
              />
              <h2 className="font-semibold text-sm tracking-tight">
                General configuration
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
                  Team name
                </FieldLabel>
                <Input
                  nativeInput
                  name="name"
                  required
                  maxLength={60}
                  defaultValue={team.name}
                  disabled={!isOwner}
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
                  defaultValue={team.slug}
                  disabled={!isOwner}
                  className="font-mono"
                />
                <FieldDescription className="font-mono text-[11px]">
                  Changing the slug will change the URL of this team.
                </FieldDescription>
              </Field>
              {isOwner && (
                <div className="flex items-center gap-3 pt-1">
                  <Button type="submit" size="sm">
                    Save changes
                  </Button>
                  <a
                    href={`/settings/teams/${team.slug}`}
                    className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
                  >
                    Discard
                  </a>
                </div>
              )}
            </form>
          </section>

          {/* Danger zone */}
          {isOwner && (
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
                  Permanently delete this team, its projects, API keys, and all
                  run history. This cannot be undone.
                </p>
                <details className="group">
                  <summary className="inline-flex h-8 cursor-pointer list-none items-center justify-center self-start rounded-md border border-destructive/32 bg-background px-3 font-mono font-medium text-[11px] text-destructive-foreground uppercase tracking-wider transition-colors hover:bg-destructive/8 [&::-webkit-details-marker]:hidden">
                    Delete team
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
                        {team.slug}
                      </code>{" "}
                      below to confirm.
                    </p>
                    <Input
                      nativeInput
                      name="confirm"
                      required
                      autoComplete="off"
                      placeholder={team.slug}
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
          )}
        </div>

        {/* Right column */}
        <div className="space-y-6 lg:col-span-2">
          {/* Active projects */}
          <section className="rounded-lg border border-border bg-card">
            <header className="flex items-center justify-between gap-2 border-border/50 border-b px-5 py-3">
              <div className="flex items-center gap-2">
                <FolderTree
                  size={14}
                  strokeWidth={2}
                  className="text-muted-foreground"
                />
                <h2 className="font-semibold text-sm tracking-tight">
                  Active projects
                </h2>
                <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
                  {projectRows.length}
                </span>
              </div>
              {isOwner && (
                <a
                  href={`/settings/teams/${team.slug}/projects/new`}
                  aria-label="Create project"
                  className="inline-flex size-6 items-center justify-center rounded-sm border border-border/50 bg-background text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                >
                  <Plus size={12} strokeWidth={2.5} />
                </a>
              )}
            </header>
            {projectRows.length === 0 ? (
              <div className="px-5 py-8 text-center text-muted-foreground text-sm">
                No projects yet.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
                    <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                      Project
                    </TableHead>
                    <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                      Slug
                    </TableHead>
                    <TableHead className="px-5 py-2.5 text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projectRows.map((p) => (
                    <TableRow
                      key={p.id}
                      className="border-border/50 border-b last:border-b-0"
                    >
                      <TableCell className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="inline-block size-1.5 shrink-0 rounded-full bg-success shadow-[0_0_6px_var(--color-success)]" />
                          <span className="font-medium text-sm">{p.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="px-5 py-3 font-mono text-muted-foreground text-xs">
                        {p.slug}
                      </TableCell>
                      <TableCell className="px-5 py-3 text-right">
                        {isOwner && (
                          <a
                            href={`/settings/teams/${team.slug}/p/${p.slug}/keys`}
                            aria-label={`Settings for ${p.name}`}
                            title="Project settings"
                            className="inline-flex size-7 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:border-border/50 hover:bg-muted hover:text-foreground"
                          >
                            <Settings2 size={14} strokeWidth={2} />
                          </a>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          {/* Team members */}
          <section className="rounded-lg border border-border bg-card">
            <header className="flex items-center justify-between gap-2 border-border/50 border-b px-5 py-3">
              <div className="flex items-center gap-2">
                <Users
                  size={14}
                  strokeWidth={2}
                  className="text-muted-foreground"
                />
                <h2 className="font-semibold text-sm tracking-tight">
                  Team members
                </h2>
                <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
                  {memberRows.length}
                </span>
                {inviteRows.length > 0 && (
                  <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
                    +{inviteRows.length} pending
                  </span>
                )}
              </div>
              {isOwner && (
                <form method="post" className="m-0">
                  <input type="hidden" name="action" value="create-invite" />
                  <button
                    type="submit"
                    aria-label="Invite a teammate"
                    title="Invite a teammate"
                    className="inline-flex size-6 items-center justify-center rounded-sm border border-border/50 bg-background text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                  >
                    <UserPlus size={12} strokeWidth={2.5} />
                  </button>
                </form>
              )}
            </header>
            {inviteError && (
              <div className="border-border/50 border-b p-5">
                <Alert variant="error">
                  <AlertDescription>{inviteError}</AlertDescription>
                </Alert>
              </div>
            )}
            <ul className="divide-y divide-border/50">
              {memberRows.map((m) => (
                <li
                  key={m.userId}
                  className="flex items-center justify-between gap-4 px-5 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted font-mono font-semibold text-[11px] text-muted-foreground">
                      {initials(m.name)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-sm">{m.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {m.email}
                      </p>
                    </div>
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                      m.role === "owner"
                        ? "border-primary/20 bg-primary/8 text-foreground"
                        : "border-border/50 bg-background text-muted-foreground",
                    )}
                  >
                    {m.role}
                  </span>
                </li>
              ))}
              {inviteRows.map((invite) => (
                <li
                  key={invite.id}
                  className="flex items-center justify-between gap-4 px-5 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border/60 bg-muted/60">
                      <LinkIcon
                        size={14}
                        strokeWidth={2}
                        className="text-muted-foreground"
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="whitespace-nowrap font-medium text-muted-foreground text-sm italic">
                        Pending invite · {formatRelativeTime(invite.createdAt)}
                      </p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {formatExpiresIn(invite.expiresAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-sm border border-border/50 bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                      {invite.role}
                    </span>
                    {isOwner && (
                      <>
                        <a
                          href={`${teamHref}?showInvite=${invite.token}`}
                          aria-label="Show invite link"
                          title="Show invite link"
                          className="inline-flex size-7 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:border-border/50 hover:bg-muted hover:text-foreground"
                        >
                          <LinkIcon size={14} strokeWidth={2} />
                        </a>
                        <form method="post" className="m-0">
                          <input
                            type="hidden"
                            name="action"
                            value="revoke-invite"
                          />
                          <input
                            type="hidden"
                            name="inviteId"
                            value={invite.id}
                          />
                          <button
                            type="submit"
                            aria-label="Revoke invite"
                            title="Revoke invite"
                            className="inline-flex size-7 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:border-destructive/32 hover:bg-destructive/8 hover:text-destructive-foreground"
                          >
                            <X size={14} strokeWidth={2} />
                          </button>
                        </form>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {shownInviteUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="invite-modal-title"
        >
          <a
            href={teamHref}
            aria-label="Close"
            className="absolute inset-0"
            tabIndex={-1}
          />
          <div className="relative z-10 w-full max-w-md rounded-lg border border-border bg-card shadow-lg">
            <header className="flex items-center justify-between gap-2 border-border/50 border-b px-5 py-3">
              <div className="flex items-center gap-2">
                <UserPlus
                  size={14}
                  strokeWidth={2}
                  className="text-muted-foreground"
                />
                <h3
                  id="invite-modal-title"
                  className="font-semibold text-sm tracking-tight"
                >
                  Invite a teammate
                </h3>
              </div>
              <a
                href={teamHref}
                aria-label="Close"
                className="inline-flex size-6 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:border-border/50 hover:bg-muted hover:text-foreground"
              >
                <X size={14} strokeWidth={2} />
              </a>
            </header>
            <div className="flex flex-col gap-4 p-5">
              <p className="text-muted-foreground text-sm leading-relaxed">
                Send your teammate this link to join{" "}
                <span className="font-medium text-foreground">{team.name}</span>
                . It&apos;s single-use,{" "}
                {shownInvite
                  ? formatExpiresIn(shownInvite.expiresAt)
                  : "expires in 7d"}
                , and stops working once they accept.
              </p>
              <Input
                nativeInput
                readOnly
                key={shownInviteUrl}
                defaultValue={shownInviteUrl}
                aria-label="Invite link"
                className="font-mono text-xs"
              />
              <div className="flex items-center justify-end gap-3 pt-1">
                <a
                  href={teamHref}
                  className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
                >
                  Done
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export async function teamDetailHandler({
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
  const action = readField(form, "action");
  const origin = new URL(request.url).origin;
  const here = `${origin}/settings/teams/${team.slug}`;

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

    if (slug !== team.slug) {
      const db = getDb();
      const clash = await db
        .selectFrom("teams")
        .select("id")
        .where("slug", "=", slug)
        .where("id", "!=", team.id)
        .limit(1)
        .executeTakeFirst();
      if (clash) {
        return redirectWithParam(
          here,
          "generalError",
          "That slug is already taken.",
        );
      }
    }

    try {
      await getDb()
        .updateTable("teams")
        .set({ name, slug })
        .where("id", "=", team.id)
        .execute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const friendly = msg.includes("UNIQUE")
        ? "That slug is already taken."
        : "Could not save changes.";
      return redirectWithParam(here, "generalError", friendly);
    }

    return Response.redirect(`${origin}/settings/teams/${slug}`, 302);
  }

  if (action === "create-invite") {
    const token = generateInviteToken();
    const nowSeconds = Math.floor(Date.now() / 1000);
    try {
      await getDb()
        .insertInto("teamInvites")
        .values({
          id: ulid(),
          teamId: team.id,
          token,
          role: "member",
          createdBy: ctx.user.id,
          createdAt: nowSeconds,
          expiresAt: nowSeconds + INVITE_TTL_SECONDS,
        })
        .execute();
    } catch {
      return redirectWithParam(
        here,
        "inviteError",
        "Could not create invite link — please try again.",
      );
    }
    return Response.redirect(`${here}?showInvite=${token}`, 302);
  }

  if (action === "revoke-invite") {
    const inviteId = readField(form, "inviteId").trim();
    if (!inviteId) {
      return Response.redirect(here, 302);
    }
    try {
      await getDb()
        .deleteFrom("teamInvites")
        .where("id", "=", inviteId)
        .where("teamId", "=", team.id)
        .execute();
    } catch {
      return redirectWithParam(
        here,
        "inviteError",
        "Could not revoke invite link — please try again.",
      );
    }
    return Response.redirect(here, 302);
  }

  if (action === "delete") {
    const confirm = readField(form, "confirm").trim();
    if (confirm !== team.slug) {
      return redirectWithParam(
        here,
        "dangerError",
        `Confirmation did not match. Type "${team.slug}" exactly to delete the team.`,
      );
    }

    const db = getDb();
    const projects = await db
      .selectFrom("projects")
      .select("id")
      .where("teamId", "=", team.id)
      .execute();
    const projectIds = projects.map((r) => r.id);

    const ops: Compilable[] = [];
    if (projectIds.length > 0) {
      ops.push(
        db.deleteFrom("apiKeys").where("projectId", "in", projectIds),
        db
          .updateTable("userState")
          .set({ lastProjectId: null })
          .where("lastProjectId", "in", projectIds),
      );
    }
    ops.push(
      db.deleteFrom("projects").where("teamId", "=", team.id),
      db.deleteFrom("memberships").where("teamId", "=", team.id),
      db.deleteFrom("teamInvites").where("teamId", "=", team.id),
      db
        .updateTable("userState")
        .set({ lastTeamId: null })
        .where("lastTeamId", "=", team.id),
      db.deleteFrom("teams").where("id", "=", team.id),
    );

    try {
      await batchD1(ops);
    } catch {
      return redirectWithParam(
        here,
        "dangerError",
        "Could not delete team — please try again.",
      );
    }

    return Response.redirect(`${origin}/settings`, 302);
  }

  return Response.redirect(here, 302);
}

function redirectWithParam(base: string, key: string, value: string): Response {
  const url = new URL(base);
  url.searchParams.set(key, value);
  return Response.redirect(url.toString(), 302);
}
