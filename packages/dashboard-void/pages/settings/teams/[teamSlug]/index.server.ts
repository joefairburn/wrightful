import { defineHandler } from "void";

/**
 * Settings → Team root. The settings UI is split across `general`, `members`,
 * and `projects` sub-pages; the bare team slug redirects to General as the
 * default landing tab.
 */
export const loader = defineHandler(async (c) => {
  const teamSlug = c.req.param("teamSlug");
  if (!teamSlug) throw new Response("Not Found", { status: 404 });
  return c.redirect(`/settings/teams/${teamSlug}/general`);
});
