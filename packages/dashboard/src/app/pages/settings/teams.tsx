import { eq } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { Button } from "@/app/components/ui/button";
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
import { memberships, teams } from "@/db/schema";
import type { AppContext } from "@/worker";

export async function SettingsTeamsPage() {
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

  return (
    <div className="mx-auto w-full max-w-4xl p-6 sm:p-8">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="font-semibold text-2xl">Teams</h1>
          <p className="text-muted-foreground text-sm">Teams you belong to.</p>
        </div>
        <Button render={<a href="/settings/teams/new">Create team</a>} />
      </header>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          You&apos;re not on any team yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Role</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.name}</TableCell>
                <TableCell className="font-mono text-xs">{t.slug}</TableCell>
                <TableCell className="text-muted-foreground">
                  {t.role}
                </TableCell>
                <TableCell>
                  <a
                    href={`/settings/teams/${t.slug}`}
                    className="text-foreground underline-offset-4 hover:underline"
                  >
                    Manage &rarr;
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
