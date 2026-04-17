import { and, desc, eq, isNull } from "drizzle-orm";
import { requestInfo } from "rwsdk/worker";
import { ulid } from "ulid";
import { Alert, AlertDescription, AlertTitle } from "@/app/components/ui/alert";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Field, FieldLabel } from "@/app/components/ui/field";
import { Input } from "@/app/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { NotFoundPage } from "@/app/pages/not-found";
import { getDb } from "@/db";
import { apiKeys } from "@/db/schema";
import { resolveProjectBySlugs } from "@/lib/authz";
import { readField } from "@/lib/form";
import { param } from "@/lib/route-params";
import type { AppContext } from "@/worker";

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

export async function AdminProjectKeysPage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  const teamSlug = param("teamSlug");
  const projectSlug = param("projectSlug");
  const project = await resolveProjectBySlugs(
    ctx.user.id,
    teamSlug,
    projectSlug,
  );
  if (!project || project.role !== "owner") return <NotFoundPage />;

  const url = new URL(requestInfo.request.url);
  const revealedKey = url.searchParams.get("key");

  const db = getDb();
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.projectId, project.id))
    .orderBy(desc(apiKeys.createdAt));

  return (
    <div className="mx-auto max-w-5xl p-6 sm:p-8">
      <div className="mb-2">
        <a
          href={`/admin/t/${project.teamSlug}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          &larr; {project.teamSlug}
        </a>
      </div>
      <h1 className="mb-1 font-semibold text-2xl">API keys — {project.name}</h1>
      <p className="mb-6 text-muted-foreground">
        Keys authorise the CLI to upload Playwright reports into this project.
      </p>

      {revealedKey && (
        <Alert variant="success" className="mb-6">
          <AlertTitle>
            Copy your new key now — it won&apos;t be shown again.
          </AlertTitle>
          <AlertDescription>
            <pre className="overflow-x-auto rounded-md bg-background p-2 font-mono text-xs">
              {revealedKey}
            </pre>
          </AlertDescription>
        </Alert>
      )}

      <form method="post" className="mb-8 flex items-end gap-3">
        <input type="hidden" name="action" value="create" />
        <Field className="flex-1">
          <FieldLabel>Label</FieldLabel>
          <Input
            nativeInput
            name="label"
            required
            maxLength={60}
            placeholder="e.g. CI main"
          />
        </Field>
        <Button type="submit">Mint key</Button>
      </form>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">No keys yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Prefix</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((k) => (
              <TableRow key={k.id}>
                <TableCell>{k.label}</TableCell>
                <TableCell className="font-mono text-xs">
                  {k.keyPrefix}…
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {k.createdAt.toISOString().slice(0, 10)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {k.lastUsedAt?.toISOString().slice(0, 10) ?? "—"}
                </TableCell>
                <TableCell>
                  {k.revokedAt ? (
                    <Badge variant="error" size="sm">
                      revoked
                    </Badge>
                  ) : (
                    <Badge variant="success" size="sm">
                      active
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {!k.revokedAt && (
                    <form method="post" className="m-0">
                      <input type="hidden" name="action" value="revoke" />
                      <input type="hidden" name="keyId" value={k.id} />
                      <Button
                        type="submit"
                        variant="destructive-outline"
                        size="sm"
                      >
                        Revoke
                      </Button>
                    </form>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export async function projectKeysHandler({
  request,
  ctx,
  params,
}: {
  request: Request;
  ctx: AppContext;
  params: Record<string, string>;
}) {
  if (!ctx.user) return new Response(null, { status: 401 });

  const project = await resolveProjectBySlugs(
    ctx.user.id,
    params.teamSlug,
    params.projectSlug,
  );
  if (!project || project.role !== "owner") {
    return new Response("Not found", { status: 404 });
  }

  const form = await request.formData();
  const action = readField(form, "action");
  const origin = new URL(request.url).origin;
  const back = `${origin}/admin/t/${project.teamSlug}/p/${project.slug}/keys`;

  const db = getDb();

  if (action === "create") {
    const label = readField(form, "label").trim();
    if (!label) return Response.redirect(back, 302);
    const rawKey = generateApiKey();
    await db.insert(apiKeys).values({
      id: ulid(),
      projectId: project.id,
      label,
      keyHash: await sha256Hex(rawKey),
      keyPrefix: rawKey.slice(0, 8),
      createdAt: new Date(),
    });
    return Response.redirect(`${back}?key=${encodeURIComponent(rawKey)}`, 302);
  }

  if (action === "revoke") {
    const keyId = readField(form, "keyId");
    if (!keyId) return Response.redirect(back, 302);
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.projectId, project.id),
          isNull(apiKeys.revokedAt),
        ),
      );
    return Response.redirect(back, 302);
  }

  return Response.redirect(back, 302);
}
