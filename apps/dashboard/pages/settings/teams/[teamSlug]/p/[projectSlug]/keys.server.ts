import { defineHandler, type InferProps } from "void";
import { and, db, desc, eq, isNull, ne } from "void/db";
import { apiKeys, projects } from "@schema";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { CODEOWNERS_FILE_MAX } from "@/lib/owner-schemas";
import { deleteProjectArtifactObjects } from "@/lib/artifacts";
import { readField } from "@/lib/form";
import { runBatch } from "@/lib/db-batch";
import {
  redirectWithParam,
  requireOwnedProjectScope,
} from "@/lib/settings-scope";
import { logger } from "void/log";
import { isValidSlug, SLUG_ERROR } from "@/lib/slug";
import { mutationErrorMessage } from "@/lib/action-errors";

export type Props = InferProps<typeof loader>;

const hereFor = (project: { teamSlug: string; slug: string }) =>
  `/settings/teams/${project.teamSlug}/p/${project.slug}/keys`;

/**
 * Settings → Project keys loader. Owner-only. Returns the project's keys list
 * and any per-section error messages stashed on a redirect.
 *
 * Minting a key happens via `POST /api/teams/:teamSlug/p/:projectSlug/keys`
 * (client-side fetch). The plaintext token comes back in that response and
 * the client surfaces it once in a modal — no flash cookie, no full reload.
 */
export const loader = defineHandler(async (c) => {
  const { project } = await requireOwnedProjectScope(c, hereFor);

  const url = new URL(c.req.url);
  const generalError = url.searchParams.get("generalError");
  const dangerError = url.searchParams.get("dangerError");
  const codeownersError = url.searchParams.get("codeownersError");

  // Explicit column list: loader props serialize into the page payload, and a
  // bare `select()` would ship every key's `keyHash` to the browser. The hash
  // isn't invertible, but it has no business in client-visible props.
  const keys = await db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.projectId, project.id))
    .orderBy(desc(apiKeys.createdAt));

  const codeownersRows = await db
    .select({
      file: projects.codeownersFile,
      updatedAt: projects.codeownersUpdatedAt,
    })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1);

  return {
    project: {
      id: project.id,
      teamId: project.teamId,
      slug: project.slug,
      name: project.name,
      teamSlug: project.teamSlug,
    },
    keys,
    codeowners: {
      file: codeownersRows[0]?.file ?? "",
      updatedAt: codeownersRows[0]?.updatedAt ?? null,
    },
    generalError,
    dangerError,
    codeownersError,
  };
});

/**
 * Settings → Project keys mutations. Mint-key is client-side via `/api/teams/.../keys`.
 * The remaining server actions handle slow-path / no-JS flows for revoke key,
 * rename / re-slug, and project delete.
 */
export const actions = {
  /** Flip `revokedAt` on a non-revoked key. Idempotent. */
  revokeKey: defineHandler(async (c) => {
    const { project, here } = await requireOwnedProjectScope(c, hereFor);

    const form = await c.req.formData();
    const keyId = readField(form, "keyId");
    if (!keyId) return c.redirect(here);
    const revoked = await db
      .update(apiKeys)
      .set({ revokedAt: Math.floor(Date.now() / 1000) })
      .where(
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.projectId, project.id),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ label: apiKeys.label, keyPrefix: apiKeys.keyPrefix });
    // Idempotent revoke: a foreign/already-revoked key matches 0 rows. Only
    // audit a genuine state change.
    if (revoked[0]) {
      await recordAudit(c, {
        teamId: project.teamId,
        projectId: project.id,
        action: AUDIT_ACTIONS.KEY_REVOKE,
        targetType: "key",
        targetId: revoked[0].label,
        metadata: {
          keyId,
          keyPrefix: revoked[0].keyPrefix,
          projectSlug: project.slug,
        },
      });
    }
    return c.redirect(here);
  }),

  /**
   * Set (or clear) the project's CODEOWNERS file — the manual paste fallback to
   * the reporter's automatic ingest (roadmap 2.3). A blank textarea clears the
   * file (sets it null). The reporter re-populates it from the repo on the next
   * run when a CODEOWNERS exists; a manual paste here is what you reach for when
   * the repo has none (or to override before the next run streams).
   */
  updateCodeowners: defineHandler(async (c) => {
    const { project, here } = await requireOwnedProjectScope(c, hereFor);

    const form = await c.req.formData();
    const raw = readField(form, "codeowners");
    if (raw.length > CODEOWNERS_FILE_MAX) {
      return redirectWithParam(
        c,
        here,
        "codeownersError",
        `CODEOWNERS file is too large (max ${CODEOWNERS_FILE_MAX} characters).`,
      );
    }
    // Trim trailing whitespace; an empty result clears the file (null).
    const trimmed = raw.trim();
    const file = trimmed.length > 0 ? trimmed : null;

    try {
      await db
        .update(projects)
        .set({
          codeownersFile: file,
          codeownersUpdatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(projects.id, project.id));
    } catch (err) {
      logger.error("update codeowners failed", {
        projectId: project.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return redirectWithParam(
        c,
        here,
        "codeownersError",
        "Could not save the CODEOWNERS file.",
      );
    }

    return c.redirect(here);
  }),

  /** Rename project or change slug. */
  updateGeneral: defineHandler(async (c) => {
    const { project, here } = await requireOwnedProjectScope(c, hereFor);

    const form = await c.req.formData();
    const name = readField(form, "name").trim();
    const slug = readField(form, "slug").trim().toLowerCase();

    if (!name) {
      return redirectWithParam(c, here, "generalError", "Name is required.");
    }
    if (!isValidSlug(slug)) {
      return redirectWithParam(c, here, "generalError", SLUG_ERROR);
    }

    if (slug !== project.slug) {
      const clash = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.teamId, project.teamId),
            eq(projects.slug, slug),
            ne(projects.id, project.id),
          ),
        )
        .limit(1);
      if (clash[0]) {
        return redirectWithParam(
          c,
          here,
          "generalError",
          "That slug is already used by another project in this team.",
        );
      }
    }

    try {
      await db
        .update(projects)
        .set({ name, slug })
        .where(eq(projects.id, project.id));
    } catch (err) {
      const friendly = mutationErrorMessage(err, {
        context: "update project failed",
        uniqueMessage:
          "That slug is already used by another project in this team.",
        genericMessage: "Could not save changes.",
      });
      return redirectWithParam(c, here, "generalError", friendly);
    }

    return c.redirect(`/settings/teams/${project.teamSlug}/p/${slug}/keys`);
  }),

  /** Delete project + its keys. */
  deleteProject: defineHandler(async (c) => {
    const { project, here } = await requireOwnedProjectScope(c, hereFor);

    const form = await c.req.formData();
    const confirm = readField(form, "confirm").trim();
    if (confirm !== project.slug) {
      return redirectWithParam(
        c,
        here,
        "dangerError",
        `Confirmation did not match. Type "${project.slug}" exactly to delete the project.`,
      );
    }

    // Record the audit row SYNCHRONOUSLY *before* the delete (roadmap 3.2): the
    // delete cascades and nulls this row's `projectId`, so we capture the
    // project's slug/name as the human-readable target NOW, while the entity
    // still exists. The row persists under its team after the project is gone.
    await recordAudit(c, {
      teamId: project.teamId,
      projectId: project.id,
      action: AUDIT_ACTIONS.PROJECT_DELETE,
      targetType: "project",
      targetId: project.slug,
      metadata: { projectName: project.name, projectId: project.id },
    });

    try {
      await runBatch([
        db.delete(apiKeys).where(eq(apiKeys.projectId, project.id)),
        db.delete(projects).where(eq(projects.id, project.id)),
      ]);
    } catch (err) {
      logger.error("delete project failed", {
        projectId: project.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return redirectWithParam(
        c,
        here,
        "dangerError",
        "Could not delete project — please try again.",
      );
    }

    // Best-effort R2 byte cleanup AFTER the authoritative row deletion, via
    // waitUntil so the sweep (up to ~200 R2 subrequests) never blocks the
    // user's redirect. A failure must not resurrect the project in the user's
    // eyes — log it and move on (the orphaned objects are unreferenced and
    // unguessable).
    c.executionCtx.waitUntil(
      deleteProjectArtifactObjects(project.teamId, project.id).catch(
        (err: unknown) => {
          logger.error("project artifact R2 sweep failed", {
            projectId: project.id,
            message: err instanceof Error ? err.message : String(err),
          });
        },
      ),
    );

    return c.redirect(`/settings/teams/${project.teamSlug}`);
  }),
};
