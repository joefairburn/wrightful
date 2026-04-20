import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { Field, FieldLabel } from "@/app/components/ui/field";
import { Input } from "@/app/components/ui/input";
import { TeamSettingsSubnav } from "@/app/components/team-settings-subnav";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { memberships, teams, user } from "@/db/schema";
import { resolveTeamBySlug } from "@/lib/authz";
import { readField } from "@/lib/form";
import { parseList } from "@/lib/whitelist";
import { param } from "@/lib/route-params";
import type { AppContext } from "@/worker";

export async function SettingsTeamDetailPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const teamSlug = param("teamSlug");
  const team = await resolveTeamBySlug(ctx.user.id, teamSlug);
  if (!team) return <NotFoundPage />;

  const db = getDb();
  const [teamRow] = await db
    .select({
      githubOrgWhitelist: teams.githubOrgWhitelist,
      emailDomainWhitelist: teams.emailDomainWhitelist,
    })
    .from(teams)
    .where(eq(teams.id, team.id))
    .limit(1);

  const memberRows = await db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      email: user.email,
      name: user.name,
    })
    .from(memberships)
    .innerJoin(user, eq(user.id, memberships.userId))
    .where(eq(memberships.teamId, team.id));

  const isOwner = team.role === "owner";
  const url = new URL(requestInfo.request.url);
  const accessErrorCode = url.searchParams.get("access_error");
  const accessErrorCopy = {
    invalid_org: "One of the GitHub org logins isn't valid.",
    invalid_domain: "One of the email domains isn't valid.",
  }[accessErrorCode ?? ""];
  const accessSaved = url.searchParams.get("access_saved") === "1";
  const inviteActive =
    parseList(teamRow?.githubOrgWhitelist).length > 0 ||
    parseList(teamRow?.emailDomainWhitelist).length > 0;
  const inviteUrl = `${env.WRIGHTFUL_PUBLIC_URL}/invite/${team.slug}`;

  return (
    <div className="mx-auto w-full max-w-4xl p-6 sm:p-8">
      <header className="mb-6">
        <h1 className="font-semibold text-2xl">{team.name}</h1>
        <p className="text-muted-foreground text-sm">Team settings</p>
      </header>

      <TeamSettingsSubnav teamSlug={team.slug} active="team" />

      <section className="mt-8 mb-10">
        <h2 className="mb-3 font-semibold text-lg">General</h2>
        <dl className="divide-y border-y text-sm">
          <div className="flex items-center gap-4 py-2">
            <dt className="w-32 text-muted-foreground">Name</dt>
            <dd className="flex-1">{team.name}</dd>
          </div>
          <div className="flex items-center gap-4 py-2">
            <dt className="w-32 text-muted-foreground">Slug</dt>
            <dd className="flex-1 font-mono text-xs">{team.slug}</dd>
          </div>
        </dl>
      </section>

      {isOwner && (
        <section className="mb-10">
          <h2 className="mb-1 font-semibold text-lg">Access control</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Anyone with the invite link who matches one of these lists can join
            this team. Leave both blank to disable the invite link.
          </p>
          {accessErrorCopy && (
            <Alert variant="error" className="mb-3">
              <AlertDescription>{accessErrorCopy}</AlertDescription>
            </Alert>
          )}
          {accessSaved && (
            <Alert className="mb-3">
              <AlertDescription>Access control updated.</AlertDescription>
            </Alert>
          )}
          <form
            method="post"
            action={`/settings/teams/${team.slug}/access-control`}
            className="flex flex-col gap-3"
          >
            <Field>
              <FieldLabel>GitHub orgs (comma-separated)</FieldLabel>
              <Input
                nativeInput
                name="github_org_whitelist"
                defaultValue={teamRow?.githubOrgWhitelist ?? ""}
                placeholder="acme, widgets"
                className="font-mono"
              />
            </Field>
            <Field>
              <FieldLabel>Email domains (comma-separated)</FieldLabel>
              <Input
                nativeInput
                name="email_domain_whitelist"
                defaultValue={teamRow?.emailDomainWhitelist ?? ""}
                placeholder="acme.com, widgets.io"
                className="font-mono"
              />
            </Field>
            <Button type="submit" className="mt-1 self-start">
              Save
            </Button>
          </form>

          {inviteActive && (
            <div className="mt-6 rounded-md border p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Invite link
              </p>
              <code className="block break-all font-mono text-sm">
                {inviteUrl}
              </code>
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 font-semibold text-lg">Members</h2>
        <ul className="divide-y border-y">
          {memberRows.map((m) => (
            <li key={m.userId} className="flex items-center gap-4 py-2 text-sm">
              <span className="flex-1">
                {m.name}{" "}
                <span className="text-muted-foreground">({m.email})</span>
              </span>
              <span className="text-muted-foreground">{m.role}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const ORG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function normalizeList(
  raw: string,
  re: RegExp,
): { normalized: string | null; invalid: string | null } {
  const items = parseList(raw);
  if (items.length === 0) return { normalized: null, invalid: null };
  for (const item of items) {
    if (!re.test(item)) return { normalized: null, invalid: item };
  }
  return { normalized: items.join(","), invalid: null };
}

export async function teamAccessControlHandler({
  request,
  ctx,
}: {
  request: Request;
  ctx: AppContext;
}) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const teamSlug = param("teamSlug");
  const team = await resolveTeamBySlug(ctx.user.id, teamSlug);
  const origin = new URL(request.url).origin;
  if (!team || team.role !== "owner") {
    return new Response(null, { status: 404 });
  }

  const form = await request.formData();
  const orgsField = readField(form, "github_org_whitelist");
  const domainsField = readField(form, "email_domain_whitelist");
  const orgs = normalizeList(orgsField, ORG_RE);
  const domains = normalizeList(domainsField, DOMAIN_RE);

  if (orgs.invalid) {
    return Response.redirect(
      `${origin}/settings/teams/${team.slug}?access_error=invalid_org`,
      302,
    );
  }
  if (domains.invalid) {
    return Response.redirect(
      `${origin}/settings/teams/${team.slug}?access_error=invalid_domain`,
      302,
    );
  }

  const db = getDb();
  await db
    .update(teams)
    .set({
      githubOrgWhitelist: orgs.normalized,
      emailDomainWhitelist: domains.normalized,
    })
    .where(eq(teams.id, team.id));

  return Response.redirect(
    `${origin}/settings/teams/${team.slug}?access_saved=1`,
    302,
  );
}
