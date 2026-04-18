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
