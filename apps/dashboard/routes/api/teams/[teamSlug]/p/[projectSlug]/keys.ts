import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { db } from "void/db";
import { ulid } from "ulid";
import { apiKeys } from "@schema";
import { resolveProjectBySlugs } from "@/lib/authz";
import { readField } from "@/lib/form";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateApiKey(): string {
  const rand = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...rand))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `wrf_${b64}`;
}

/**
 * POST /api/teams/:teamSlug/p/:projectSlug/keys
 *
 * Owner-only. Mints a new API key for the project and returns the freshly
 * minted plaintext token in the response body — the client surfaces it once
 * in a modal. The plaintext is never written to storage; only the hash and
 * the 8-char prefix are persisted.
 *
 * This replaces the server-side `createKey` action on the keys page so the
 * UI can stay on the page without a full reload.
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);
  const teamSlug = c.req.param("teamSlug");
  const projectSlug = c.req.param("projectSlug");
  if (!teamSlug || !projectSlug) {
    return c.json({ error: "Not found" }, 404);
  }

  const project = await resolveProjectBySlugs(user.id, teamSlug, projectSlug);
  if (!project || project.role !== "owner") {
    return c.json({ error: "Forbidden" }, 403);
  }

  let label: string;
  const ctype = c.req.header("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const body = (await c.req.json()) as { label?: unknown };
    label = typeof body.label === "string" ? body.label.trim() : "";
  } else {
    const form = await c.req.formData();
    label = readField(form, "label").trim();
  }
  if (!label) {
    return c.json({ error: "Label is required" }, 400);
  }
  if (label.length > 60) {
    return c.json({ error: "Label is too long" }, 400);
  }

  const token = generateApiKey();
  const id = ulid();
  const createdAt = Math.floor(Date.now() / 1000);
  const keyPrefix = token.slice(0, 8);

  await db.insert(apiKeys).values({
    id,
    projectId: project.id,
    label,
    keyHash: await sha256Hex(token),
    keyPrefix,
    createdAt,
    lastUsedAt: null,
    revokedAt: null,
  });

  return c.json({
    key: {
      id,
      label,
      keyPrefix,
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
    },
    token,
  });
});
