import type { RouteMiddleware } from "rwsdk/router";
import { validateApiKey } from "@/lib/auth";

const PROTOCOL_VERSION_MIN = 1;
// v2: ingest response includes `results: [{ clientKey, testResultId }]`
// mapping so the CLI can attach artifacts. v1 requests are still accepted —
// they simply don't receive the mapping (and can't upload artifacts).
const PROTOCOL_VERSION_MAX = 2;

export const requireAuth: RouteMiddleware = async ({ request, ctx }) => {
  const authHeader = request.headers.get("Authorization");
  const apiKey = await validateApiKey(authHeader);

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  ctx.apiKey = apiKey;
};

export const negotiateVersion: RouteMiddleware = ({ request }) => {
  const versionHeader = request.headers.get("X-Greenroom-Version");
  if (!versionHeader) return; // allow requests without version header for now

  const version = parseInt(versionHeader, 10);
  if (isNaN(version)) {
    return new Response(
      JSON.stringify({ error: "Invalid X-Greenroom-Version header" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (version < PROTOCOL_VERSION_MIN) {
    return new Response(
      JSON.stringify({
        error:
          "CLI version too old. Please upgrade @greenroom/cli to the latest version.",
        minimumVersion: PROTOCOL_VERSION_MIN,
        maximumVersion: PROTOCOL_VERSION_MAX,
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }

  if (version > PROTOCOL_VERSION_MAX) {
    return new Response(
      JSON.stringify({
        error:
          "Dashboard version too old. Please upgrade your Greenroom dashboard.",
        minimumVersion: PROTOCOL_VERSION_MIN,
        maximumVersion: PROTOCOL_VERSION_MAX,
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }
};
