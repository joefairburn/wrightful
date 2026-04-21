import { Check, Github, Undo2, Users, X } from "lucide-react";
import { requestInfo } from "rwsdk/worker";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { NotFoundPage } from "@/app/pages/not-found";
import { LoginGithubButton } from "@/app/pages/login-github-button";
import { getDb } from "@/db";
import { getSuggestedTeamsForUser } from "@/lib/authz";
import { hasReadOrgScope, refreshUserOrgs } from "@/lib/github-orgs";
import type { AppContext } from "@/worker";

export async function SettingsProfilePage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  // /settings/profile is the canonical place to see what teams are available
  // to you, so refresh the GitHub org cache on every load. Sidebar renders
  // rely on the cache alone for speed; this endpoint is the fresh source.
  const refresh = await refreshUserOrgs(ctx.user.id);

  const db = getDb();
  const githubAccount = await db
    .selectFrom("account")
    .select(["scope"])
    .where("userId", "=", ctx.user.id)
    .where("providerId", "=", "github")
    .limit(1)
    .executeTakeFirst();

  const hasGithub = Boolean(githubAccount);
  const scopeOk = hasGithub
    ? hasReadOrgScope(githubAccount?.scope) && refresh.kind !== "scope_missing"
    : false;

  const suggestions = await getSuggestedTeamsForUser(ctx.user.id);

  return (
    <div className="mx-auto w-full max-w-3xl p-6 sm:p-8">
      <header className="mb-6 border-border/50 border-b pb-5">
        <h1 className="font-semibold text-2xl tracking-tight">Profile</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {ctx.user.name}{" "}
          <span className="font-mono text-muted-foreground/70">
            · {ctx.user.email}
          </span>
        </p>
      </header>

      {hasGithub && !scopeOk && (
        <div className="mb-6">
          <Alert>
            <AlertDescription>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm">
                  Reconnect GitHub to let us look up your organisations.
                  We&apos;ll ask for the <code>read:org</code> scope so teams
                  linked to your orgs can appear here.
                </span>
                <LoginGithubButton callbackURL="/settings/profile" />
              </div>
            </AlertDescription>
          </Alert>
        </div>
      )}

      {suggestions.length > 0 && (
        <section className="rounded-lg border border-border bg-card">
          <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
            <Users
              size={14}
              strokeWidth={2}
              className="text-muted-foreground"
            />
            <h2 className="font-semibold text-sm tracking-tight">
              Teams available to join
            </h2>
            <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
              {suggestions.length}
            </span>
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
                      {s.dismissed && (
                        <span className="ml-2 inline-flex items-center rounded-sm border border-border/50 bg-background px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground uppercase tracking-wider">
                          Dismissed
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {s.dismissed ? (
                    <form
                      method="post"
                      action={`/api/user/team-suggestions/${s.id}/undismiss`}
                      className="m-0"
                    >
                      <button
                        type="submit"
                        aria-label={`Restore ${s.name} suggestion`}
                        title="Restore suggestion"
                        className="inline-flex size-7 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:border-border/50 hover:bg-muted hover:text-foreground"
                      >
                        <Undo2 size={14} strokeWidth={2} />
                      </button>
                    </form>
                  ) : (
                    <form
                      method="post"
                      action={`/api/user/team-suggestions/${s.id}/dismiss`}
                      className="m-0"
                    >
                      <button
                        type="submit"
                        aria-label={`Dismiss ${s.name}`}
                        title="Dismiss"
                        className="inline-flex size-7 items-center justify-center rounded-sm border border-transparent text-muted-foreground transition-colors hover:border-border/50 hover:bg-muted hover:text-foreground"
                      >
                        <X size={14} strokeWidth={2} />
                      </button>
                    </form>
                  )}
                  <form
                    method="post"
                    action={`/t/${s.slug}/join`}
                    className="m-0"
                  >
                    <button
                      type="submit"
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 font-mono font-medium text-[11px] text-foreground uppercase tracking-wider transition-colors hover:bg-accent"
                    >
                      <Check size={12} strokeWidth={2.5} />
                      Join
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
