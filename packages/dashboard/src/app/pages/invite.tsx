import { Check, Users } from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import { ulid } from "ulid";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { getDb } from "@/db";
import { batchD1 } from "@/db/batch";
import { hashInviteToken } from "@/lib/invite-tokens";
import { param } from "@/lib/route-params";
import type { AppContext } from "@/worker";

export async function InvitePage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <InviteShell>{null}</InviteShell>;

  const token = param("token");
  const url = new URL(requestInfo.request.url);
  const error = url.searchParams.get("error");

  const db = getDb();
  const tokenHash = await hashInviteToken(token);
  const invite = await db
    .selectFrom("teamInvites")
    .innerJoin("teams", "teams.id", "teamInvites.teamId")
    .select([
      "teamInvites.id as id",
      "teamInvites.teamId as teamId",
      "teamInvites.role as role",
      "teams.slug as teamSlug",
      "teams.name as teamName",
    ])
    .where("teamInvites.tokenHash", "=", tokenHash)
    .where("teamInvites.expiresAt", ">", Math.floor(Date.now() / 1000))
    .limit(1)
    .executeTakeFirst();

  if (!invite) {
    return (
      <InviteShell>
        <h1 className="font-semibold text-2xl tracking-tight">
          Invite not valid
        </h1>
        <p className="text-muted-foreground text-sm">
          {error ??
            "This invite link is no longer active. Ask the team owner for a fresh link."}
        </p>
        <a
          href="/"
          className="mt-2 inline-flex font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
        >
          Go home
        </a>
      </InviteShell>
    );
  }

  const existingMembership = await db
    .selectFrom("memberships")
    .select("id")
    .where("userId", "=", ctx.user.id)
    .where("teamId", "=", invite.teamId)
    .limit(1)
    .executeTakeFirst();

  if (existingMembership) {
    return (
      <InviteShell>
        <div className="flex size-10 items-center justify-center rounded-full border border-success/24 bg-success/8">
          <Check
            size={18}
            strokeWidth={2.5}
            className="text-success-foreground"
          />
        </div>
        <h1 className="font-semibold text-2xl tracking-tight">
          You&apos;re already on this team
        </h1>
        <p className="text-muted-foreground text-sm">
          You&apos;re already a member of{" "}
          <span className="font-medium text-foreground">{invite.teamName}</span>
          .
        </p>
        <Button render={<a href={`/t/${invite.teamSlug}`}>Go to team</a>} />
      </InviteShell>
    );
  }

  return (
    <InviteShell>
      <div className="flex size-10 items-center justify-center rounded-full border border-border/50 bg-muted">
        <Users size={18} strokeWidth={2} className="text-muted-foreground" />
      </div>
      <h1 className="font-semibold text-2xl tracking-tight">
        Join {invite.teamName}
      </h1>
      <p className="text-muted-foreground text-sm">
        You&apos;ve been invited to join{" "}
        <span className="font-medium text-foreground">{invite.teamName}</span>{" "}
        as a{" "}
        <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider">
          {invite.role}
        </span>
        .
      </p>
      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <form method="post" className="flex items-center gap-3">
        <Button type="submit">Accept invite</Button>
        <a
          href="/"
          className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
        >
          Not now
        </a>
      </form>
    </InviteShell>
  );
}

function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <section className="flex w-full max-w-md flex-col items-start gap-4 rounded-lg border border-border bg-card p-8">
        {children}
      </section>
    </main>
  );
}

export async function acceptInviteHandler({
  request,
  ctx,
  params,
}: {
  request: Request;
  ctx: AppContext;
  params: Record<string, string>;
}) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const token = params.token;
  const origin = new URL(request.url).origin;
  const here = `${origin}/invite/${token}`;

  const db = getDb();
  const tokenHash = await hashInviteToken(token);
  const invite = await db
    .selectFrom("teamInvites")
    .innerJoin("teams", "teams.id", "teamInvites.teamId")
    .select([
      "teamInvites.id as id",
      "teamInvites.teamId as teamId",
      "teamInvites.role as role",
      "teams.slug as teamSlug",
    ])
    .where("teamInvites.tokenHash", "=", tokenHash)
    .where("teamInvites.expiresAt", ">", Math.floor(Date.now() / 1000))
    .limit(1)
    .executeTakeFirst();

  if (!invite) {
    const url = new URL(here);
    url.searchParams.set(
      "error",
      "This invite is no longer valid. Ask the team owner for a fresh link.",
    );
    return Response.redirect(url.toString(), 302);
  }

  const existing = await db
    .selectFrom("memberships")
    .select("id")
    .where("userId", "=", ctx.user.id)
    .where("teamId", "=", invite.teamId)
    .limit(1)
    .executeTakeFirst();

  if (existing) {
    // Already a member — don't burn the invite, just redirect.
    return Response.redirect(`${origin}/t/${invite.teamSlug}`, 302);
  }

  try {
    await batchD1([
      db.insertInto("memberships").values({
        id: ulid(),
        userId: ctx.user.id,
        teamId: invite.teamId,
        role: invite.role,
        createdAt: Math.floor(Date.now() / 1000),
      }),
      db.deleteFrom("teamInvites").where("id", "=", invite.id),
    ]);
  } catch {
    const url = new URL(here);
    url.searchParams.set(
      "error",
      "Could not join the team — please try again.",
    );
    return Response.redirect(url.toString(), 302);
  }

  return Response.redirect(`${origin}/t/${invite.teamSlug}`, 302);
}
