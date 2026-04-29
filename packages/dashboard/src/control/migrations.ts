import { sql } from "kysely";
import { type Migrations } from "rwsdk/db";

/**
 * Control-DO migrations. Run inside the singleton `ControlDO` at
 * `createDb()` time via rwsdk/db's InMemoryMigrationProvider. TS types for
 * the whole control schema are inferred from the builders returned by
 * `up()` — see `Database<typeof controlMigrations>` in `./index.ts`. No
 * hand-written interface required.
 *
 * Identifiers are camelCase in both TS and the emitted SQL — same convention
 * as the tenant DO migrations (no CamelCasePlugin layer). Better Auth's
 * kyselyAdapter uses camelCase TS-side field names (`userId`, `emailVerified`,
 * …), which now match the SQL column names verbatim.
 *
 * Pre-launch policy (matches tenant): on schema change, edit `0000_init` in
 * place and redeploy; don't stack numbered migrations.
 */

const nowMs = sql<number>`(cast(unixepoch('subsecond') * 1000 as integer))`;

export const controlMigrations = {
  "0000_init": {
    async up(db) {
      // ---------- Better Auth core tables ----------

      const user = await db.schema
        .createTable("user")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("email", "text", (c) => c.notNull())
        .addColumn("emailVerified", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("image", "text")
        .addColumn("createdAt", "integer", (c) => c.notNull().defaultTo(nowMs))
        .addColumn("updatedAt", "integer", (c) => c.notNull().defaultTo(nowMs))
        .execute();

      await db.schema
        .createIndex("user_email_unique")
        .unique()
        .on("user")
        .column("email")
        .execute();

      const session = await db.schema
        .createTable("session")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("expiresAt", "integer", (c) => c.notNull())
        .addColumn("token", "text", (c) => c.notNull())
        .addColumn("createdAt", "integer", (c) => c.notNull().defaultTo(nowMs))
        .addColumn("updatedAt", "integer", (c) => c.notNull())
        .addColumn("ipAddress", "text")
        .addColumn("userAgent", "text")
        .addColumn("userId", "text", (c) =>
          c.notNull().references("user.id").onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createIndex("session_token_unique")
        .unique()
        .on("session")
        .column("token")
        .execute();
      await db.schema
        .createIndex("session_userId_idx")
        .on("session")
        .column("userId")
        .execute();

      const account = await db.schema
        .createTable("account")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("accountId", "text", (c) => c.notNull())
        .addColumn("providerId", "text", (c) => c.notNull())
        .addColumn("userId", "text", (c) =>
          c.notNull().references("user.id").onDelete("cascade"),
        )
        .addColumn("accessToken", "text")
        .addColumn("refreshToken", "text")
        .addColumn("idToken", "text")
        .addColumn("accessTokenExpiresAt", "integer")
        .addColumn("refreshTokenExpiresAt", "integer")
        .addColumn("scope", "text")
        .addColumn("password", "text")
        .addColumn("createdAt", "integer", (c) => c.notNull().defaultTo(nowMs))
        .addColumn("updatedAt", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("account_userId_idx")
        .on("account")
        .column("userId")
        .execute();

      const verification = await db.schema
        .createTable("verification")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("identifier", "text", (c) => c.notNull())
        .addColumn("value", "text", (c) => c.notNull())
        .addColumn("expiresAt", "integer", (c) => c.notNull())
        .addColumn("createdAt", "integer", (c) => c.notNull().defaultTo(nowMs))
        .addColumn("updatedAt", "integer", (c) => c.notNull().defaultTo(nowMs))
        .execute();

      await db.schema
        .createIndex("verification_identifier_idx")
        .on("verification")
        .column("identifier")
        .execute();

      // ---------- Tenancy ----------

      const teams = await db.schema
        .createTable("teams")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("slug", "text", (c) => c.notNull())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .addColumn("lastActivityAt", "integer")
        .addColumn("githubOrgSlug", "text")
        .execute();

      await db.schema
        .createIndex("teams_slug_idx")
        .unique()
        .on("teams")
        .column("slug")
        .execute();
      await db.schema
        .createIndex("teams_lastActivityAt_idx")
        .on("teams")
        .column("lastActivityAt")
        .execute();
      await db.schema
        .createIndex("teams_githubOrg_idx")
        .on("teams")
        .column("githubOrgSlug")
        .execute();

      const projects = await db.schema
        .createTable("projects")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("teamId", "text", (c) =>
          c.notNull().references("teams.id").onDelete("cascade"),
        )
        .addColumn("slug", "text", (c) => c.notNull())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("projects_team_slug_idx")
        .unique()
        .on("projects")
        .columns(["teamId", "slug"])
        .execute();

      const memberships = await db.schema
        .createTable("memberships")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("userId", "text", (c) =>
          c.notNull().references("user.id").onDelete("cascade"),
        )
        .addColumn("teamId", "text", (c) =>
          c.notNull().references("teams.id").onDelete("cascade"),
        )
        .addColumn("role", "text", (c) => c.notNull())
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("memberships_user_team_idx")
        .unique()
        .on("memberships")
        .columns(["userId", "teamId"])
        .execute();
      await db.schema
        .createIndex("memberships_team_idx")
        .on("memberships")
        .column("teamId")
        .execute();

      const teamInvites = await db.schema
        .createTable("teamInvites")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("teamId", "text", (c) =>
          c.notNull().references("teams.id").onDelete("cascade"),
        )
        .addColumn("tokenHash", "text", (c) => c.notNull())
        .addColumn("role", "text", (c) => c.notNull())
        .addColumn("createdBy", "text", (c) =>
          c.notNull().references("user.id").onDelete("cascade"),
        )
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .addColumn("expiresAt", "integer", (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex("teamInvites_tokenHash_idx")
        .unique()
        .on("teamInvites")
        .column("tokenHash")
        .execute();
      await db.schema
        .createIndex("teamInvites_team_idx")
        .on("teamInvites")
        .column("teamId")
        .execute();

      const teamSuggestionDismissals = await db.schema
        .createTable("teamSuggestionDismissals")
        .addColumn("userId", "text", (c) =>
          c.notNull().references("user.id").onDelete("cascade"),
        )
        .addColumn("teamId", "text", (c) =>
          c.notNull().references("teams.id").onDelete("cascade"),
        )
        .addColumn("dismissedAt", "integer", (c) => c.notNull())
        .addPrimaryKeyConstraint("teamSuggestionDismissals_pk", [
          "userId",
          "teamId",
        ])
        .execute();

      const userGithubOrgs = await db.schema
        .createTable("userGithubOrgs")
        .addColumn("userId", "text", (c) =>
          c.primaryKey().references("user.id").onDelete("cascade"),
        )
        .addColumn("orgSlugsJson", "text", (c) => c.notNull())
        .addColumn("refreshedAt", "integer", (c) => c.notNull())
        .addColumn("scopeOk", "integer", (c) => c.notNull())
        .execute();

      const userState = await db.schema
        .createTable("userState")
        .addColumn("userId", "text", (c) =>
          c.primaryKey().references("user.id").onDelete("cascade"),
        )
        .addColumn("lastTeamId", "text", (c) =>
          c.references("teams.id").onDelete("set null"),
        )
        .addColumn("lastProjectId", "text", (c) =>
          c.references("projects.id").onDelete("set null"),
        )
        .addColumn("updatedAt", "integer", (c) => c.notNull())
        .execute();

      // ---------- API keys ----------

      const apiKeys = await db.schema
        .createTable("apiKeys")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("projectId", "text", (c) =>
          c.notNull().references("projects.id").onDelete("cascade"),
        )
        .addColumn("label", "text", (c) => c.notNull())
        .addColumn("keyHash", "text", (c) => c.notNull())
        .addColumn("keyPrefix", "text", (c) => c.notNull())
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .addColumn("lastUsedAt", "integer")
        .addColumn("revokedAt", "integer")
        .execute();

      await db.schema
        .createIndex("apiKeys_project_idx")
        .on("apiKeys")
        .column("projectId")
        .execute();
      await db.schema
        .createIndex("apiKeys_keyPrefix_idx")
        .on("apiKeys")
        .column("keyPrefix")
        .execute();

      return [
        user,
        session,
        account,
        verification,
        teams,
        projects,
        memberships,
        teamInvites,
        teamSuggestionDismissals,
        userGithubOrgs,
        userState,
        apiKeys,
      ];
    },

    async down(db) {
      await db.schema.dropTable("apiKeys").ifExists().execute();
      await db.schema.dropTable("userState").ifExists().execute();
      await db.schema.dropTable("userGithubOrgs").ifExists().execute();
      await db.schema
        .dropTable("teamSuggestionDismissals")
        .ifExists()
        .execute();
      await db.schema.dropTable("teamInvites").ifExists().execute();
      await db.schema.dropTable("memberships").ifExists().execute();
      await db.schema.dropTable("projects").ifExists().execute();
      await db.schema.dropTable("teams").ifExists().execute();
      await db.schema.dropTable("verification").ifExists().execute();
      await db.schema.dropTable("account").ifExists().execute();
      await db.schema.dropTable("session").ifExists().execute();
      await db.schema.dropTable("user").ifExists().execute();
    },
  },
} satisfies Migrations;
