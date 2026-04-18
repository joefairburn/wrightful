import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { TeamSettingsSubnav } from "@/app/components/team-settings-subnav";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { memberships, user } from "@/db/schema";
import { resolveTeamBySlug } from "@/lib/authz";
import { param } from "@/lib/route-params";
import type { AppContext } from "@/worker";

export async function SettingsTeamDetailPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const teamSlug = param("teamSlug");
  const team = await resolveTeamBySlug(ctx.user.id, teamSlug);
  if (!team) return <NotFoundPage />;

  const db = getDb();
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
