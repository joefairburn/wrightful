import { env } from "cloudflare:workers";
import { render, route, prefix, layout } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";
import {
  SyncedStateServer,
  syncedStateRoutes,
} from "rwsdk/use-synced-state/worker";

import { AppLayout } from "@/app/components/app-layout";
import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";
import { requireAuth, negotiateVersion } from "@/routes/api/middleware";
import {
  openRunHandler,
  appendResultsHandler,
  completeRunHandler,
} from "@/routes/api/runs";
import { getAuth } from "@/lib/better-auth";
import { resolveProjectBySlugs } from "@/lib/authz";

// Realtime fan-out: re-export the rwsdk DO class so Cloudflare can find it
// via the binding declared in wrangler.jsonc.
export { SyncedStateServer };

// Per-team tenant DO. Re-exported at module level so Workers registers it
// under the `TENANT` binding. All tenant-owned tables (runs, testResults,
// …) live inside each team's instance — routed via `getTenantDb`.
export { TenantDO } from "@/tenant/tenant-do";

// Register the namespace so the DO can build self-stubs when firing the
// setState persistence handler from inside its own instance.
SyncedStateServer.registerNamespace(env.SYNCED_STATE_SERVER);

// Gate every realtime WS connection on team membership. Room IDs are shaped
// `run:<teamSlug>:<projectSlug>:<runId>`; anyone not a member of the team
// gets a thrown error and the WS fails to open. Defense in depth: ingest
// writes use API-key auth (separate surface); realtime reads use the Better
// Auth session.
SyncedStateServer.registerRoomHandler(async (roomId, reqInfo) => {
  if (!roomId) throw new Error("forbidden");
  const match = roomId.match(/^run:([^:]+):([^:]+):([^:]+)$/);
  if (!match) throw new Error("forbidden");
  const [, teamSlug, projectSlug] = match;
  const request = reqInfo?.request;
  if (!request) throw new Error("forbidden");
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user?.id) throw new Error("forbidden");
  const scope = await resolveProjectBySlugs(
    session.user.id,
    teamSlug,
    projectSlug,
  );
  if (!scope) throw new Error("forbidden");
  return roomId;
});
import { registerHandler } from "@/routes/api/artifacts";
import { artifactUploadHandler } from "@/routes/api/artifact-upload";
import { artifactDownloadHandler } from "@/routes/api/artifact-download";
import { runSummaryHandler } from "@/routes/api/run-summary";
import { testResultSummaryHandler } from "@/routes/api/test-result-summary";
import { runTestPreviewHandler } from "@/routes/api/run-test-preview";
import {
  setLastProjectHandler,
  setLastTeamHandler,
} from "@/routes/api/user-state";
import {
  dismissSuggestionHandler,
  joinTeamHandler,
  undismissSuggestionHandler,
} from "@/routes/api/team-suggestions";
import { authHandler } from "@/routes/auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { loadSession, requireUser } from "@/routes/middleware";
import { scheduledHandler } from "@/scheduled";

// Native Cloudflare rate limiters — configured in wrangler.jsonc#ratelimits.
const authRateLimit = rateLimit(env.AUTH_RATE_LIMITER, (request) => {
  // No stable identity pre-auth; fall back to IP + pathname so a single
  // caller can't exhaust sign-in and sign-up simultaneously from the same
  // bucket. CF recommends against raw IP keys for multi-tenant apps, but
  // for unauthenticated auth endpoints it's the best we have.
  const path = new URL(request.url).pathname;
  return `${clientIp(request)}:${path}`;
});

const apiRateLimit = rateLimit(env.API_RATE_LIMITER, (_request, ctx) => {
  // `requireAuth` runs before this in the middleware chain, so ctx.apiKey
  // is always populated here. Keying on apiKey.id gives a tenant-scoped
  // limit instead of a shared-egress-IP limit (CI runners behind a NAT all
  // look identical otherwise).
  const apiKey = (ctx as { apiKey?: { id: string } }).apiKey;
  return apiKey ? `apiKey:${apiKey.id}` : null;
});

const artifactRateLimit = rateLimit(env.ARTIFACT_RATE_LIMITER, (request) => {
  // Key on the artifact id (from the URL path), not the caller, because a
  // single trace.playwright.dev load fires many ranged requests for the
  // same zip. IP fallback guards when the path doesn't match.
  const match = new URL(request.url).pathname.match(
    /\/api\/artifacts\/([^/]+)\/download/,
  );
  return match ? `artifact:${match[1]}` : `ip:${clientIp(request)}`;
});
import { RunsListPage } from "@/app/pages/runs-list";
import { RunDetailPage } from "@/app/pages/run-detail";
import { TestDetailPage } from "@/app/pages/test-detail";
import { TestHistoryPage } from "@/app/pages/test-history";
import { LoginPage } from "@/app/pages/login";
import { InvitePage, acceptInviteHandler } from "@/app/pages/invite";
import { TeamPickerPage } from "@/app/pages/team-picker";
import { ProjectPickerPage } from "@/app/pages/project-picker";
import { SettingsProfilePage } from "@/app/pages/settings/profile";
import {
  SettingsTeamNewPage,
  createTeamHandler,
} from "@/app/pages/settings/team-new";
import {
  SettingsTeamDetailPage,
  teamDetailHandler,
} from "@/app/pages/settings/team-detail";
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
    image: string | null;
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
    `${new URL(request.url).origin}/settings/profile`,
    302,
  );
}

const app = defineApp([
  setCommonHeaders(),

  // Realtime WebSocket route for useSyncedState clients. Auth is enforced
  // inside the static `registerRoomHandler` above (throws on missing
  // session or non-member).
  ...syncedStateRoutes(() => env.SYNCED_STATE_SERVER),

  // Signed-token artifact download (see lib/artifact-tokens.ts).
  route("/api/artifacts/:id/download", {
    get: [artifactRateLimit, artifactDownloadHandler],
    head: [artifactRateLimit, artifactDownloadHandler],
  }),

  // Better Auth catch-all — must be declared before the bearer-token /api
  // prefix so the API-key middleware doesn't intercept sign-in requests.
  route("/api/auth/*", [authRateLimit, authHandler]),

  // Dashboard session-backed user-state endpoints — must precede the bearer /api
  // prefix so they're gated on the Better Auth cookie, not an API key.
  route("/api/user/last-team", {
    post: [loadSession, requireUser, setLastTeamHandler],
  }),
  route("/api/user/last-project", {
    post: [loadSession, requireUser, setLastProjectHandler],
  }),
  route("/api/user/team-suggestions/:teamId/dismiss", {
    post: [loadSession, requireUser, dismissSuggestionHandler],
  }),
  route("/api/user/team-suggestions/:teamId/undismiss", {
    post: [loadSession, requireUser, undismissSuggestionHandler],
  }),
  route("/api/t/:teamSlug/p/:projectSlug/runs/:runId/test-preview", {
    get: [loadSession, requireUser, runTestPreviewHandler],
  }),
  route("/api/t/:teamSlug/p/:projectSlug/runs/:runId/summary", {
    get: [loadSession, requireUser, runSummaryHandler],
  }),
  route(
    "/api/t/:teamSlug/p/:projectSlug/runs/:runId/tests/:testResultId/summary",
    {
      get: [loadSession, requireUser, testResultSummaryHandler],
    },
  ),

  // Bearer-token API routes (used by the CLI). requireAuth runs before the
  // rate limiter so we can key by apiKey.id (stable, tenant-scoped) instead
  // of by IP.
  prefix("/api", [
    requireAuth,
    apiRateLimit,
    negotiateVersion,
    route("/runs", {
      post: openRunHandler,
    }),
    route("/runs/:id/results", {
      post: appendResultsHandler,
    }),
    route("/runs/:id/complete", {
      post: completeRunHandler,
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
    route("/invite/:token", {
      get: [requireUser, InvitePage],
      post: [requireUser, acceptInviteHandler],
    }),
    route("/t/:teamSlug/join", {
      post: [requireUser, joinTeamHandler],
    }),
    ...layout(AppLayout, [
      // Settings — declared first so prefixes win over app routes.
      route("/settings", settingsRootRedirect),
      route("/settings/profile", [requireUser, SettingsProfilePage]),
      route("/settings/teams/new", {
        get: [requireUser, SettingsTeamNewPage],
        post: [requireUser, createTeamHandler],
      }),
      route("/settings/teams/:teamSlug", {
        get: [requireUser, SettingsTeamDetailPage],
        post: [requireUser, teamDetailHandler],
      }),
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

// Cloudflare Workers module format: `fetch` handles HTTP, `scheduled`
// handles Cron Triggers. Object.assign preserves rwsdk's AppDefinition
// shape (including `__rwRoutes`) so `linkFor<App>()` in app/links.ts can
// still infer route paths from the default export.
export default Object.assign(app, {
  scheduled: scheduledHandler,
});
