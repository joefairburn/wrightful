import { render, route, prefix, layout } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { AppLayout } from "@/app/components/app-layout";
import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";
import { requireAuth, negotiateVersion } from "@/routes/api/middleware";
import { ingestHandler } from "@/routes/api/ingest";
import { registerHandler } from "@/routes/api/artifacts";
import { artifactUploadHandler } from "@/routes/api/artifact-upload";
import { artifactDownloadHandler } from "@/routes/api/artifact-download";
import {
  setLastProjectHandler,
  setLastTeamHandler,
} from "@/routes/api/user-state";
import { authHandler } from "@/routes/auth";
import { loadSession, requireUser } from "@/routes/middleware";
import { RunsListPage } from "@/app/pages/runs-list";
import { RunDetailPage } from "@/app/pages/run-detail";
import { TestDetailPage } from "@/app/pages/test-detail";
import { TestHistoryPage } from "@/app/pages/test-history";
import { LoginPage } from "@/app/pages/login";
import { TeamPickerPage } from "@/app/pages/team-picker";
import { ProjectPickerPage } from "@/app/pages/project-picker";
import { SettingsProfilePage } from "@/app/pages/settings/profile";
import { SettingsTeamsPage } from "@/app/pages/settings/teams";
import {
  SettingsTeamNewPage,
  createTeamHandler,
} from "@/app/pages/settings/team-new";
import { SettingsTeamDetailPage } from "@/app/pages/settings/team-detail";
import { SettingsProjectsPage } from "@/app/pages/settings/projects";
import {
  SettingsProjectNewPage,
  createProjectHandler,
} from "@/app/pages/settings/project-new";
import {
  SettingsProjectKeysPage,
  projectKeysHandler,
} from "@/app/pages/settings/project-keys";

export interface AppContext {
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
}

declare module "rwsdk/worker" {
  interface DefaultAppContext extends AppContext {}
}

function settingsRootRedirect({ request }: { request: Request }) {
  return Response.redirect(
    `${new URL(request.url).origin}/settings/teams`,
    302,
  );
}

export default defineApp([
  setCommonHeaders(),

  // Unauthenticated artifact download — unguessable ulid gates access.
  route("/api/artifacts/:id/download", {
    get: artifactDownloadHandler,
    head: artifactDownloadHandler,
  }),

  // Better Auth catch-all — must be declared before the bearer-token /api
  // prefix so the API-key middleware doesn't intercept sign-in requests.
  route("/api/auth/*", authHandler),

  // Dashboard session-backed user-state endpoints — must precede the bearer /api
  // prefix so they're gated on the Better Auth cookie, not an API key.
  route("/api/user/last-team", {
    post: [loadSession, requireUser, setLastTeamHandler],
  }),
  route("/api/user/last-project", {
    post: [loadSession, requireUser, setLastProjectHandler],
  }),

  // Bearer-token API routes (used by the CLI)
  prefix("/api", [
    requireAuth,
    negotiateVersion,
    route("/ingest", {
      post: ingestHandler,
    }),
    route("/artifacts/register", {
      post: registerHandler,
    }),
    route("/artifacts/:id/upload", {
      put: artifactUploadHandler,
    }),
  ]),

  // Dashboard pages. /login and /signup sit outside AppLayout so they render
  // without the sidebar; everything else shares the global shell.
  render(Document, [
    loadSession,
    route("/login", LoginPage),
    route("/signup", LoginPage),
    ...layout(AppLayout, [
      // Settings — declared first so prefixes win over app routes.
      route("/settings", settingsRootRedirect),
      route("/settings/profile", [requireUser, SettingsProfilePage]),
      route("/settings/teams", [requireUser, SettingsTeamsPage]),
      route("/settings/teams/new", {
        get: [requireUser, SettingsTeamNewPage],
        post: [requireUser, createTeamHandler],
      }),
      route("/settings/teams/:teamSlug", [requireUser, SettingsTeamDetailPage]),
      route("/settings/teams/:teamSlug/projects", [
        requireUser,
        SettingsProjectsPage,
      ]),
      route("/settings/teams/:teamSlug/projects/new", {
        get: [requireUser, SettingsProjectNewPage],
        post: [requireUser, createProjectHandler],
      }),
      route("/settings/teams/:teamSlug/p/:projectSlug/keys", {
        get: [requireUser, SettingsProjectKeysPage],
        post: [requireUser, projectKeysHandler],
      }),

      // Main app
      route("/", [requireUser, TeamPickerPage]),
      route("/t/:teamSlug", [requireUser, ProjectPickerPage]),
      route("/t/:teamSlug/p/:projectSlug", [requireUser, RunsListPage]),
      route("/t/:teamSlug/p/:projectSlug/runs/:id", [
        requireUser,
        RunDetailPage,
      ]),
      route("/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId", [
        requireUser,
        TestDetailPage,
      ]),
      route("/t/:teamSlug/p/:projectSlug/tests/:testId", [
        requireUser,
        TestHistoryPage,
      ]),
    ]),
  ]),
]);
