import { render, route, prefix } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";
import { requireAuth, negotiateVersion } from "@/routes/api/middleware";
import { ingestHandler } from "@/routes/api/ingest";
import { presignHandler } from "@/routes/api/artifacts";
import { artifactDownloadHandler } from "@/routes/api/artifact-download";
import { authHandler } from "@/routes/auth";
import { loadSession, requireUser } from "@/routes/middleware";
import { RunsListPage } from "@/app/pages/runs-list";
import { RunDetailPage } from "@/app/pages/run-detail";
import { TestDetailPage } from "@/app/pages/test-detail";
import { TestHistoryPage } from "@/app/pages/test-history";
import { LoginPage } from "@/app/pages/login";
import { TeamPickerPage } from "@/app/pages/team-picker";
import { ProjectPickerPage } from "@/app/pages/project-picker";
import { AdminTeamsPage } from "@/app/pages/admin/teams";
import {
  AdminTeamNewPage,
  createTeamHandler,
} from "@/app/pages/admin/team-new";
import { AdminTeamDetailPage } from "@/app/pages/admin/team-detail";
import {
  AdminProjectNewPage,
  createProjectHandler,
} from "@/app/pages/admin/project-new";
import {
  AdminProjectKeysPage,
  projectKeysHandler,
} from "@/app/pages/admin/project-keys";

export type AppContext = {
  apiKey?: {
    id: string;
    label: string;
    projectId: string;
  };
  user?: {
    id: string;
    email: string;
    name: string;
  };
  session?: {
    id: string;
    expiresAt: Date;
  };
};

export default defineApp([
  setCommonHeaders(),

  // Unauthenticated artifact download — unguessable ulid gates access.
  route("/api/artifacts/:id/download", artifactDownloadHandler),

  // Better Auth catch-all — must be declared before the bearer-token /api
  // prefix so the API-key middleware doesn't intercept sign-in requests.
  route("/api/auth/*", authHandler),

  // Bearer-token API routes (used by the CLI)
  prefix("/api", [
    requireAuth,
    negotiateVersion,
    route("/ingest", {
      post: ingestHandler,
    }),
    route("/artifacts/presign", {
      post: presignHandler,
    }),
  ]),

  // Dashboard pages — always behind a signed-in user.
  render(Document, [
    loadSession,
    route("/login", LoginPage),
    route("/", [requireUser, TeamPickerPage]),
    route("/t/:teamSlug", [requireUser, ProjectPickerPage]),
    route("/t/:teamSlug/p/:projectSlug", [requireUser, RunsListPage]),
    route("/t/:teamSlug/p/:projectSlug/runs/:id", [requireUser, RunDetailPage]),
    route("/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId", [
      requireUser,
      TestDetailPage,
    ]),
    route("/t/:teamSlug/p/:projectSlug/tests/:testId", [
      requireUser,
      TestHistoryPage,
    ]),

    // Admin
    route("/admin/teams", [requireUser, AdminTeamsPage]),
    route("/admin/teams/new", {
      get: [requireUser, AdminTeamNewPage],
      post: [requireUser, createTeamHandler],
    }),
    route("/admin/t/:teamSlug", [requireUser, AdminTeamDetailPage]),
    route("/admin/t/:teamSlug/projects/new", {
      get: [requireUser, AdminProjectNewPage],
      post: [requireUser, createProjectHandler],
    }),
    route("/admin/t/:teamSlug/p/:projectSlug/keys", {
      get: [requireUser, AdminProjectKeysPage],
      post: [requireUser, projectKeysHandler],
    }),
  ]),
]);
