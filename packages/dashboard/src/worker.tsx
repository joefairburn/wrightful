import { render, route, prefix } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";
import { requireAuth, negotiateVersion } from "@/routes/api/middleware";
import { ingestHandler } from "@/routes/api/ingest";
import { presignHandler } from "@/routes/api/artifacts";
import { RunsListPage } from "@/app/pages/runs-list";
import { RunDetailPage } from "@/app/pages/run-detail";

export type AppContext = {
  apiKey?: {
    id: string;
    label: string;
  };
};

export default defineApp([
  setCommonHeaders(),

  // API routes — return raw JSON, not wrapped in Document
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
  ]),
]);
