import { and, eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { ulid } from "ulid";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { Card, CardPanel } from "@/app/components/ui/card";
import { getDb } from "@/db";
import { account, memberships, teams } from "@/db/schema";
import { fetchUserOrgLogins } from "@/lib/github-api";
import { param } from "@/lib/route-params";
import { matchesWhitelist, parseList } from "@/lib/whitelist";
import type { AppContext } from "@/worker";

interface InviteTeam {
  id: string;
  slug: string;
  name: string;
  githubOrgWhitelist: string | null;
  emailDomainWhitelist: string | null;
}

async function loadInviteTeam(slug: string): Promise<InviteTeam | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: teams.id,
      slug: teams.slug,
      name: teams.name,
      githubOrgWhitelist: teams.githubOrgWhitelist,
      emailDomainWhitelist: teams.emailDomainWhitelist,
    })
    .from(teams)
    .where(eq(teams.slug, slug))
    .limit(1);
  return row ?? null;
}

function isInviteEnabled(team: InviteTeam): boolean {
  return (
    parseList(team.githubOrgWhitelist).length > 0 ||
    parseList(team.emailDomainWhitelist).length > 0
  );
}

async function isMember(userId: string, teamId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.teamId, teamId)))
    .limit(1);
  return !!row;
}

async function loadGithubAccessToken(userId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  return row?.accessToken ?? null;
}

function InviteShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-[440px]">
        <h1 className="mb-6 text-center text-2xl font-medium tracking-tight">
          {title}
        </h1>
        <Card>
          <CardPanel className="flex flex-col gap-4">{children}</CardPanel>
        </Card>
      </div>
    </main>
  );
}

export async function InvitePage() {
  const ctx = requestInfo.ctx as AppContext;
  const teamSlug = param("teamSlug");
  const team = await loadInviteTeam(teamSlug);

  if (!team || !isInviteEnabled(team)) {
    return (
      <InviteShell title="Invite not available">
        <p className="text-sm text-muted-foreground">
          This invite link is invalid or has been disabled.
        </p>
      </InviteShell>
    );
  }

  if (!ctx.user) {
    const callbackURL = encodeURIComponent(`/invite/${team.slug}`);
    return (
      <InviteShell title={`Join ${team.name}`}>
        <p className="text-sm text-muted-foreground">
          Sign in with GitHub to accept this invite.
        </p>
        <Button
          render={
            <a href={`/api/auth/sign-in/github?callbackURL=${callbackURL}`}>
              Continue with GitHub
            </a>
          }
        />
      </InviteShell>
    );
  }

  if (await isMember(ctx.user.id, team.id)) {
    const origin = new URL(requestInfo.request.url).origin;
    return Response.redirect(`${origin}/t/${team.slug}`, 302);
  }

  const accessToken = await loadGithubAccessToken(ctx.user.id);
  if (!accessToken) {
    return (
      <InviteShell title={`Join ${team.name}`}>
        <Alert variant="error">
          <AlertDescription>
            This invite requires GitHub sign-in. Sign out and retry with GitHub.
          </AlertDescription>
        </Alert>
      </InviteShell>
    );
  }

  const config = {
    allowedOrgs: parseList(team.githubOrgWhitelist),
    allowedDomains: parseList(team.emailDomainWhitelist),
  };

  let orgs: string[];
  try {
    orgs = await fetchUserOrgLogins(accessToken);
  } catch {
    return (
      <InviteShell title={`Join ${team.name}`}>
        <Alert variant="error">
          <AlertDescription>
            Couldn&apos;t verify your GitHub membership — try again in a moment.
          </AlertDescription>
        </Alert>
      </InviteShell>
    );
  }

  const allowed = matchesWhitelist({ email: ctx.user.email, orgs }, config);

  if (!allowed) {
    return (
      <InviteShell title={`Join ${team.name}`}>
        <Alert variant="error">
          <AlertDescription>
            Your GitHub account isn&apos;t on this team&apos;s allow-list.
          </AlertDescription>
        </Alert>
      </InviteShell>
    );
  }

  return (
    <InviteShell title={`Join ${team.name}`}>
      <p className="text-sm text-muted-foreground">
        You&apos;re eligible to join <strong>{team.name}</strong> as a member.
      </p>
      <form method="post" className="flex flex-col gap-2">
        <Button type="submit">Accept invite</Button>
      </form>
    </InviteShell>
  );
}

export async function acceptInviteHandler({
  request,
  ctx,
}: {
  request: Request;
  ctx: AppContext;
}) {
  const origin = new URL(request.url).origin;
  if (!ctx.user) {
    return Response.redirect(`${origin}/login`, 302);
  }
  const teamSlug = param("teamSlug");
  const team = await loadInviteTeam(teamSlug);
  if (!team || !isInviteEnabled(team)) {
    return Response.redirect(`${origin}/invite/${teamSlug}`, 302);
  }

  // Re-run the check server-side — never trust that the GET view did it.
  const accessToken = await loadGithubAccessToken(ctx.user.id);
  if (!accessToken) {
    return Response.redirect(`${origin}/invite/${team.slug}`, 302);
  }
  let orgs: string[];
  try {
    orgs = await fetchUserOrgLogins(accessToken);
  } catch {
    return Response.redirect(`${origin}/invite/${team.slug}`, 302);
  }
  const allowed = matchesWhitelist(
    { email: ctx.user.email, orgs },
    {
      allowedOrgs: parseList(team.githubOrgWhitelist),
      allowedDomains: parseList(team.emailDomainWhitelist),
    },
  );
  if (!allowed) {
    return Response.redirect(`${origin}/invite/${team.slug}`, 302);
  }

  const db = getDb();
  await db
    .insert(memberships)
    .values({
      id: ulid(),
      userId: ctx.user.id,
      teamId: team.id,
      role: "member",
      createdAt: new Date(),
    })
    .onConflictDoNothing({
      target: [memberships.userId, memberships.teamId],
    });

  return Response.redirect(`${origin}/t/${team.slug}`, 302);
}
