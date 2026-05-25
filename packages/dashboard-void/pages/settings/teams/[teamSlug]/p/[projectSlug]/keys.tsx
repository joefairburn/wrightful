import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowLeft,
  FolderCog,
  KeyRound,
  Plus,
} from "lucide-react";
import { Link } from "@void/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/cn";
import type { Props } from "./keys.server";

/**
 * Settings → Project keys.
 *
 * Four embedded forms posting to the same URL (project-detail style):
 *   - update-general: rename / change project slug
 *   - create        : mint a new API key (label only; plaintext flashed back)
 *   - revoke        : flip `revokedAt` on a key
 *   - delete        : nuke the project
 *
 * A freshly-minted key's plaintext is delivered via an HttpOnly flash cookie
 * that the loader reads + clears in a single render — never persisted, never
 * in the URL.
 */
export default function SettingsProjectKeysPage({
  project,
  keys,
  revealedKey,
  generalError,
  dangerError,
}: Props) {
  const here = `/settings/teams/${project.teamSlug}/p/${project.slug}/keys`;
  return (
    <div className="mx-auto w-full max-w-5xl p-6 sm:p-8">
      <div className="mb-6 border-border/50 border-b pb-5">
        <Link
          href={`/settings/teams/${project.teamSlug}`}
          className="mb-3 inline-flex items-center gap-1.5 font-mono text-muted-foreground text-xs transition-colors hover:text-foreground"
        >
          <ArrowLeft size={12} strokeWidth={2} />
          Team
        </Link>
        <h1 className="font-semibold text-2xl tracking-tight">
          Project settings
        </h1>
        <p className="mt-1 flex items-center gap-2 font-mono text-muted-foreground text-xs">
          <span className="text-muted-foreground/70">project:</span>
          <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
            {project.name}
          </span>
        </p>
      </div>

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

      <div className="space-y-6">
        <section className="rounded-lg border border-border bg-card">
          <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
            <FolderCog
              size={14}
              strokeWidth={2}
              className="text-muted-foreground"
            />
            <h2 className="font-semibold text-sm tracking-tight">
              Project details
            </h2>
          </header>
          <form
            method="post"
            action={`${here}?updateGeneral`}
            className="flex flex-col gap-4 p-5"
          >
            {generalError && (
              <Alert variant="error">
                <AlertDescription>{generalError}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                Project name
              </FieldLabel>
              <Input
                nativeInput
                name="name"
                required
                maxLength={60}
                defaultValue={project.name}
              />
            </Field>
            <Field>
              <FieldLabel className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                URL slug
              </FieldLabel>
              <Input
                nativeInput
                name="slug"
                required
                pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
                maxLength={40}
                defaultValue={project.slug}
                className="font-mono"
              />
              <FieldDescription className="font-mono text-[11px]">
                Changing the slug will change the URL of this project.
              </FieldDescription>
            </Field>
            <div className="flex items-center gap-3 pt-1">
              <Button type="submit" size="sm">
                Save changes
              </Button>
              <Link
                href={`/settings/teams/${project.teamSlug}/p/${project.slug}/keys`}
                className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
              >
                Discard
              </Link>
            </div>
          </form>
        </section>

        <section className="rounded-lg border border-border bg-card">
          <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
            <Plus size={14} strokeWidth={2} className="text-muted-foreground" />
            <h2 className="font-semibold text-sm tracking-tight">
              Mint a new key
            </h2>
          </header>
          <form
            method="post"
            action={`${here}?createKey`}
            className="flex items-end gap-3 p-5"
          >
            <Field className="flex-1">
              <FieldLabel className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                Label
              </FieldLabel>
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
        </section>

        <section className="rounded-lg border border-border bg-card">
          <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
            <KeyRound
              size={14}
              strokeWidth={2}
              className="text-muted-foreground"
            />
            <h2 className="font-semibold text-sm tracking-tight">Keys</h2>
            <span className="rounded-sm border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
              {keys.length}
            </span>
          </header>
          {keys.length === 0 ? (
            <div className="px-5 py-8 text-center text-muted-foreground text-sm">
              No keys yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Label
                  </TableHead>
                  <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Prefix
                  </TableHead>
                  <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Created
                  </TableHead>
                  <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Last used
                  </TableHead>
                  <TableHead className="px-5 py-2.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                    Status
                  </TableHead>
                  <TableHead className="px-5 py-2.5" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => {
                  const revoked = Boolean(k.revokedAt);
                  return (
                    <TableRow
                      key={k.id}
                      className="border-border/50 border-b last:border-b-0"
                    >
                      <TableCell className="px-5 py-3 font-medium text-sm">
                        {k.label}
                      </TableCell>
                      <TableCell className="px-5 py-3 font-mono text-muted-foreground text-xs">
                        {k.keyPrefix}…
                      </TableCell>
                      <TableCell className="px-5 py-3 font-mono text-muted-foreground text-xs tabular-nums">
                        {format(new Date(k.createdAt * 1000), "yyyy-MM-dd")}
                      </TableCell>
                      <TableCell className="px-5 py-3 font-mono text-muted-foreground text-xs tabular-nums">
                        {k.lastUsedAt
                          ? format(new Date(k.lastUsedAt * 1000), "yyyy-MM-dd")
                          : "—"}
                      </TableCell>
                      <TableCell className="px-5 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                            revoked
                              ? "border-destructive/20 bg-destructive/8 text-destructive-foreground"
                              : "border-success/24 bg-success/8 text-success-foreground",
                          )}
                        >
                          <span
                            className={cn(
                              "inline-block size-1.5 rounded-full",
                              revoked
                                ? "bg-destructive"
                                : "bg-success shadow-[0_0_6px_var(--color-success)]",
                            )}
                          />
                          {revoked ? "revoked" : "active"}
                        </span>
                      </TableCell>
                      <TableCell className="px-5 py-3 text-right">
                        {!revoked && (
                          <form
                            method="post"
                            action={`${here}?revokeKey`}
                            className="m-0 inline-flex"
                          >
                            <input type="hidden" name="keyId" value={k.id} />
                            <button
                              type="submit"
                              className="inline-flex h-7 cursor-pointer items-center justify-center rounded-sm border border-destructive/32 bg-background px-2.5 font-mono text-[10px] text-destructive-foreground uppercase tracking-wider transition-colors hover:bg-destructive/8"
                            >
                              Revoke
                            </button>
                          </form>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </section>

        <section className="rounded-lg border border-destructive/24 bg-card">
          <header className="flex items-center gap-2 border-destructive/20 border-b px-5 py-3">
            <AlertTriangle
              size={14}
              strokeWidth={2}
              className="text-destructive-foreground"
            />
            <h2 className="font-semibold text-destructive-foreground text-sm tracking-tight">
              Danger zone
            </h2>
          </header>
          <div className="flex flex-col gap-3 p-5">
            <p className="text-muted-foreground text-xs leading-relaxed">
              Permanently delete this project, its API keys, and all run
              history. This cannot be undone.
            </p>
            <details className="group">
              <summary className="inline-flex h-8 cursor-pointer list-none items-center justify-center self-start rounded-md border border-destructive/32 bg-background px-3 font-mono font-medium text-[11px] text-destructive-foreground uppercase tracking-wider transition-colors hover:bg-destructive/8 [&::-webkit-details-marker]:hidden">
                Delete project
              </summary>
              <form
                method="post"
                action={`${here}?deleteProject`}
                className="mt-4 flex flex-col gap-3 border-destructive/20 border-t pt-4"
              >
                {dangerError && (
                  <Alert variant="error">
                    <AlertDescription>{dangerError}</AlertDescription>
                  </Alert>
                )}
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Type{" "}
                  <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                    {project.slug}
                  </code>{" "}
                  below to confirm.
                </p>
                <Input
                  nativeInput
                  name="confirm"
                  required
                  autoComplete="off"
                  placeholder={project.slug}
                  className="font-mono"
                />
                <button
                  type="submit"
                  className="inline-flex h-8 cursor-pointer items-center justify-center self-start rounded-md border border-destructive bg-destructive px-3 font-mono font-medium text-[11px] text-white uppercase tracking-wider transition-colors hover:bg-destructive/90"
                >
                  Permanently delete
                </button>
              </form>
            </details>
          </div>
        </section>
      </div>
    </div>
  );
}
