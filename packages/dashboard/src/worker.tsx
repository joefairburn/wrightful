import { render, route, prefix } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";
import { requireAuth, negotiateVersion } from "@/routes/api/middleware";
import { ingestHandler } from "@/routes/api/ingest";
import { presignHandler } from "@/routes/api/artifacts";
import { artifactDownloadHandler } from "@/routes/api/artifact-download";
import { RunsListPage } from "@/app/pages/runs-list";
import { RunDetailPage } from "@/app/pages/run-detail";
import { TestDetailPage } from "@/app/pages/test-detail";
import { TestHistoryPage } from "@/app/pages/test-history";

export type AppContext = {
  apiKey?: {
    id: string;
    label: string;
  };
};

export default defineApp([
  setCommonHeaders(),

  // Unauthenticated artifact download — unguessable ulid gates access.
  // Declared before the authenticated /api prefix so requireAuth doesn't run.
  route("/api/artifacts/:id/download", artifactDownloadHandler),

  // Authenticated API routes — return raw JSON, not wrapped in Document
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

  // Dashboard pages — RSC wrapped in Document shell
  render(Document, [
    route("/", RunsListPage),
    route("/runs/:id", RunDetailPage),
    route("/runs/:runId/tests/:testResultId", TestDetailPage),
    route("/tests/:testId", TestHistoryPage),
  ]),
]);
