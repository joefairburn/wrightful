import { Check, Github } from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import { Button } from "@/app/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/app/components/ui/empty";
import { NotFoundPage } from "@/app/pages/not-found";
import { getSuggestedTeamsForUser } from "@/lib/authz";
import { getCachedUserOrgs, refreshUserOrgs } from "@/lib/github-orgs";
import { resolveDefaultLanding } from "@/lib/user-state";
import type { AppContext } from "@/worker";

export async function TeamPickerPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const target = await resolveDefaultLanding(ctx.user.id);
  if (target) {
    const origin = new URL(requestInfo.request.url).origin;
    const path =
      target.kind === "project"
        ? `/t/${target.teamSlug}/p/${target.projectSlug}`
        : `/t/${target.teamSlug}`;
    return Response.redirect(`${origin}${path}`, 302);
  }

  // First-run landing: the user has no teams. If the Better Auth
  // post-OAuth hook didn't warm the cache (existing user, transient
  // GitHub error, etc.), fall back to an awaited refresh so the
  // list is present on this critical page.
  const cached = await getCachedUserOrgs(ctx.user.id);
  if (!cached) {
    await refreshUserOrgs(ctx.user.id).catch(() => undefined);
  }

  const suggestions = await getSuggestedTeamsForUser(ctx.user.id);

  if (suggestions.length === 0) {
    return (
      <div className="mx-auto max-w-2xl p-6 sm:p-8">
        <h1 className="mb-6 font-semibold text-2xl">Your teams</h1>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No teams yet</EmptyTitle>
            <EmptyDescription>
              You&apos;re not a member of any team yet. Create one to start
              collecting Playwright runs.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<a href="/settings/teams/new">Create a team</a>} />
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6 sm:p-8">
      <header className="mb-6">
        <h1 className="font-semibold text-2xl tracking-tight">Get started</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Your GitHub organisations have teams set up on Wrightful. Join one, or
          create your own.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-card">
        <header className="border-border/50 border-b px-5 py-3">
          <h2 className="font-semibold text-sm tracking-tight">
            Available via GitHub
          </h2>
        </header>
        <ul className="divide-y divide-border/50">
          {suggestions.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-4 px-5 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted text-muted-foreground">
                  <Github size={14} strokeWidth={2} />
                </div>
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{s.name}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    github.com/{s.githubOrgSlug}
                  </p>
                </div>
              </div>
              <form method="post" action={`/t/${s.slug}/join`} className="m-0">
                <button
                  type="submit"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 font-mono font-medium text-[11px] text-foreground uppercase tracking-wider transition-colors hover:bg-accent"
                >
                  <Check size={12} strokeWidth={2.5} />
                  Join
                </button>
              </form>
            </li>
          ))}
        </ul>
        <div className="border-border/50 border-t px-5 py-3 text-center">
          <a
            href="/settings/teams/new"
            className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
          >
            Or create your own team →
          </a>
        </div>
      </section>
    </div>
  );
}
