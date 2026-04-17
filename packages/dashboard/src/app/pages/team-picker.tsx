import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/app/components/ui/empty";
import { Button } from "@/app/components/ui/button";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { memberships, teams } from "@/db/schema";
import type { AppContext } from "@/worker";

export async function TeamPickerPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const db = getDb();
  const rows = await db
    .select({
      id: teams.id,
      slug: teams.slug,
      name: teams.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(teams, eq(teams.id, memberships.teamId))
    .where(eq(memberships.userId, ctx.user.id));

  if (rows.length === 1) {
    return Response.redirect(
      `${new URL(requestInfo.request.url).origin}/t/${rows[0].slug}`,
      302,
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6 sm:p-8">
      <h1 className="mb-6 font-semibold text-2xl">Your teams</h1>
      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No teams yet</EmptyTitle>
            <EmptyDescription>
              You&apos;re not a member of any team yet. Create one to start
              collecting Playwright runs.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<a href="/admin/teams/new">Create a team</a>} />
          </EmptyContent>
        </Empty>
      ) : (
        <ul className="divide-y border-y">
          {rows.map((t) => (
            <li key={t.id}>
              <a
                href={`/t/${t.slug}`}
                className="flex items-baseline gap-2 py-3 hover:bg-accent/32"
              >
                <strong className="font-semibold">{t.name}</strong>
                <span className="text-muted-foreground text-sm">{t.role}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-8">
        <a
          href="/admin/teams"
          className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
        >
          Manage teams &rarr;
        </a>
      </div>
    </div>
  );
}
