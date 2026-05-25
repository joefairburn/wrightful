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
import { Link } from "@void/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/time-format";
import type { Props } from "./index.server";

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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

/**
 * Settings → Team detail.
 *
 * Four embedded forms posting to the same URL, dispatched by a hidden
 * `action` field on the server:
 *   - update-general: rename / change slug
 *   - create-invite : mint a single-use share link (or directed invite)
 *   - revoke-invite : nuke a pending invite by id
 *   - delete        : permanently delete the team (owner confirms slug)
 *
 * The `?newInvite=<id>` query param + an HttpOnly flash cookie set by the
 * action drive a one-shot modal that reveals the plaintext invite URL.
 */
export default function SettingsTeamDetailPage({
  team,
  members,
  projects,
  invites,
  generalError,
  dangerError,
  inviteError,
  shownInviteId,
  shownInviteUrl,
}: Props) {
  const isOwner = team.role === "owner";
  const teamHref = `/settings/teams/${team.slug}`;
  const shownInvite = shownInviteId
    ? invites.find((i) => i.id === shownInviteId)
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl p-6 sm:p-8">
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
            <form
              method="post"
              action={`${teamHref}?updateGeneral`}
              className="flex flex-col gap-4 p-5"
            >
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
                  <Link
                    href={`/settings/teams/${team.slug}`}
                    className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
                  >
                    Discard
                  </Link>
                </div>
              )}
            </form>
          </section>

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
                    action={`${teamHref}?deleteTeam`}
                    className="mt-4 flex flex-col gap-3 border-destructive/20 border-t pt-4"
                  >
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
                  {projects.length}
                </span>
              </div>
              {isOwner && (
                <Link
                  href={`/settings/teams/${team.slug}/projects/new`}
                  aria-label="Create project"
                  className="inline-flex size-6 items-center justify-center rounded-sm border border-border/50 bg-background text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                >
                  <Plus size={12} strokeWidth={2.5} />
                </Link>
              )}
            </header>
            {projects.length === 0 ? (
              <div className="px-5 py-8 text-center text-muted-foreground text-sm">
                No projects yet.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
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
                  {projects.map((p) => (
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
                          <Link
                            href={`/settings/teams/${team.slug}/p/${p.slug}/keys`}
                            aria-label={`Settings for ${p.name}`}
                            title="Project settings"
                            className="inline-flex size-7 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:border-border/50 hover:bg-muted hover:text-foreground"
                          >
                            <Settings2 size={14} strokeWidth={2} />
                          </Link>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

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
                  {members.length}
                </span>
                {invites.length > 0 && (
                  <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
                    +{invites.length} pending
                  </span>
                )}
              </div>
              {isOwner && (
                <form
                  method="post"
                  action={`${teamHref}?createInvite`}
                  className="flex items-center gap-2 m-0"
                  aria-label="Invite a teammate"
                >
                  <Input
                    nativeInput
                    type="text"
                    name="inviteIdentifier"
                    placeholder="email or github username"
                    aria-label="Email or GitHub username (optional)"
                    autoComplete="off"
                    maxLength={254}
                    className="h-7 w-56 font-mono text-xs"
                  />
                  <button
                    type="submit"
                    aria-label="Create invite"
                    title="Create invite"
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 font-mono font-medium text-[11px] text-foreground uppercase tracking-wider transition-colors hover:bg-accent"
                  >
                    <UserPlus size={12} strokeWidth={2.5} />
                    Invite
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
              {members.map((m) => (
                <li
                  key={m.userId}
                  className="flex items-center justify-between gap-4 px-5 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {m.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={m.image}
                        alt=""
                        width={32}
                        height={32}
                        className="size-8 shrink-0 rounded-full border border-border/50 bg-muted object-cover"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted font-mono font-semibold text-[11px] text-muted-foreground">
                        {initials(m.name)}
                      </div>
                    )}
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
              {invites.map((invite) => (
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
                      <p className="truncate font-medium text-muted-foreground text-sm italic">
                        {invite.email
                          ? `Invite · ${invite.email}`
                          : invite.githubLogin
                            ? `Invite · @${invite.githubLogin}`
                            : `Pending invite · ${formatRelativeTime(invite.createdAt)}`}
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
                      <form
                        method="post"
                        action={`${teamHref}?revokeInvite`}
                        className="m-0"
                      >
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
          <Link
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
              <Link
                href={teamHref}
                aria-label="Close"
                className="inline-flex size-6 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:border-border/50 hover:bg-muted hover:text-foreground"
              >
                <X size={14} strokeWidth={2} />
              </Link>
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
                <Link
                  href={teamHref}
                  className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
                >
                  Done
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
