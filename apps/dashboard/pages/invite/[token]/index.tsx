import { Check, Users } from "lucide-react";
import { Link } from "@void/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Props } from "./index.server";

/**
 * Invite landing page. The token in the URL is one of two things:
 *   1. A live invite the signed-in user can accept → render the join card.
 *   2. Something we can't honor (expired, mismatch, already a member) → render
 *      a contextual message in the same shell.
 *
 * Loader normalises every case into a discriminated union so the component
 * stays a pure render. POSTing the form re-runs the colocated `action` which
 * creates the membership and redirects to `/t/<teamSlug>`.
 */
export default function InvitePage(props: Props) {
  if (props.kind === "invalid") {
    return (
      <InviteShell>
        <h1 className="font-semibold text-2xl tracking-tight">
          Invite not valid
        </h1>
        <p className="text-muted-foreground text-sm">{props.message}</p>
        <Link
          href="/"
          className="mt-2 inline-flex text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Go home
        </Link>
      </InviteShell>
    );
  }

  if (props.kind === "directed_mismatch") {
    return (
      <InviteShell>
        <h1 className="font-semibold text-2xl tracking-tight">
          Invite not for this account
        </h1>
        <p className="text-muted-foreground text-sm">{props.message}</p>
        <Link
          href="/"
          className="mt-2 inline-flex text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Go home
        </Link>
      </InviteShell>
    );
  }

  if (props.kind === "already_member") {
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
          <span className="font-medium text-foreground">
            {props.invite.teamName}
          </span>
          .
        </p>
        <Button
          render={<Link href={`/t/${props.invite.teamSlug}`}>Go to team</Link>}
        />
      </InviteShell>
    );
  }

  const { invite, error } = props;

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
        <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 text-[11px] font-medium capitalize">
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
        <Link
          href="/"
          className="text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Not now
        </Link>
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
