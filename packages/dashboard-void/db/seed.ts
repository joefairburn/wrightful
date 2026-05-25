import { defineSeed } from "void/seed";
import { ulid } from "ulid";

/**
 * Minimal dev seed: one team, one project. The user that owns this seed
 * data is expected to sign up via the dashboard first (Void manages the
 * `user` table outside of this Drizzle schema, see db/schema.ts header).
 *
 * Run with `pnpm db:seed`. Adjust IDs if you need deterministic fixtures.
 */
export default defineSeed<typeof import("./schema")>(async ({ db, schema }) => {
  const now = Date.now();
  const teamId = ulid();
  const projectId = ulid();
  await db.insert(schema.teams).values({
    id: teamId,
    slug: "demo",
    name: "Demo Team",
    createdAt: now,
    lastActivityAt: now,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    teamId,
    slug: "demo-project",
    name: "Demo Project",
    createdAt: now,
  });
});
