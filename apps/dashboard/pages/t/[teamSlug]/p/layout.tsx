import { AppLayout } from "@/components/app-layout";

/**
 * Project shell — wraps every `/t/:teamSlug/p/:projectSlug/**` route in the
 * AppLayout's app chrome (team/project switchers + tenant nav). Active team
 * + project come from `useShared()`, populated by `middleware/01.context.ts`
 * on tenant paths.
 *
 * Lives at `t/[teamSlug]/p/` (NOT `t/[teamSlug]/p/[projectSlug]/`) on purpose:
 * void's layout resolver strips the trailing `/index` from page componentIds,
 * so a layout at the same level as `[projectSlug]/index.tsx` does NOT wrap
 * that index page — only its siblings (flaky.tsx, tests.tsx, insights/*,
 * runs/[runId]/*). Hoisting the layout one directory up makes `t/[teamSlug]/p`
 * reachable from the index page's componentId chain so it wraps every project
 * route uniformly. The `p` directory has no pages of its own (only the
 * `[projectSlug]/` subdirectory), so this layout's scope is unchanged.
 *
 * Deliberately scoped here (not at `pages/t/[teamSlug]/layout.tsx`) because
 * the team picker at `/t/:teamSlug` renders standalone — it has no active
 * project, so the sidebar nav would be empty.
 */
export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppLayout mode="app">{children}</AppLayout>;
}
