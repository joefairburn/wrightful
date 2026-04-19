import type { RouteMiddleware } from "rwsdk/router";
import { validateApiKey } from "@/lib/auth";

// v3 is the only supported protocol: the streaming reporter hits
// /api/runs (open / results / complete). Older versions are hard-rejected.
const PROTOCOL_VERSION_MIN = 3;
const PROTOCOL_VERSION_MAX = 3;

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
  const versionHeader = request.headers.get("X-Wrightful-Version");
  if (!versionHeader) return; // allow requests without version header for now

  const version = parseInt(versionHeader, 10);
  if (isNaN(version)) {
    return new Response(
      JSON.stringify({ error: "Invalid X-Wrightful-Version header" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (version < PROTOCOL_VERSION_MIN) {
    return new Response(
      JSON.stringify({
        error:
          "Client version too old. Please upgrade @wrightful/reporter to the latest version.",
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
          "Dashboard version too old. Please upgrade your Wrightful dashboard.",
        minimumVersion: PROTOCOL_VERSION_MIN,
        maximumVersion: PROTOCOL_VERSION_MAX,
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }
};
