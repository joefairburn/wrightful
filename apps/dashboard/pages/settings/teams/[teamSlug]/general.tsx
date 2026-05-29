import { Link } from "@void/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SettingsCard,
  SettingsField,
  SettingsGroupGap,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import type { Props } from "./general.server";

/**
 * Settings → Team → General. Identity (name + slug) and Danger zone
 * (delete team). Members + Projects are sibling routes.
 */
export default function SettingsTeamGeneralPage({
  team,
  projectCount,
  generalError,
  dangerError,
}: Props) {
  const isOwner = team.role === "owner";
  const here = `/settings/teams/${team.slug}/general`;

  return (
    <SettingsPage>
      <SettingsHeader
        title={`${team.name} · General`}
        subtitle="Settings that apply to every project in this team."
      />

      <SettingsCard title="Identity">
        <form action={`${here}?updateGeneral`} className="m-0" method="post">
          {generalError && (
            <Alert className="mb-3" variant="error">
              <AlertDescription>{generalError}</AlertDescription>
            </Alert>
          )}
          <SettingsField label="Team name">
            <Input
              defaultValue={team.name}
              disabled={!isOwner}
              maxLength={60}
              name="name"
              nativeInput
              required
            />
          </SettingsField>
          <SettingsField
            hint={
              <>
                The URL is <code className="font-mono">/t/{team.slug}</code> —
                changing this will break existing links.
              </>
            }
            label="URL slug"
          >
            <Input
              className="font-mono"
              defaultValue={team.slug}
              disabled={!isOwner}
              maxLength={40}
              name="slug"
              nativeInput
              pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
              required
            />
          </SettingsField>
          {isOwner && (
            <div className="mt-2 flex items-center gap-3">
              <Button size="sm" type="submit">
                Save changes
              </Button>
              <Link
                className="font-mono text-[11px] text-fg-3 uppercase tracking-wider transition-colors hover:text-fg-1"
                href={here}
              >
                Discard
              </Link>
            </div>
          )}
        </form>
      </SettingsCard>

      {isOwner && (
        <>
          <SettingsGroupGap />
          <SettingsCard title="Danger zone" tone="danger">
            <div className="flex flex-col gap-3">
              <p className="text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
                Permanently deletes{" "}
                <span className="font-medium text-fg-1">{team.name}</span> and
                all <span className="font-mono">{projectCount}</span>{" "}
                {projectCount === 1 ? "project" : "projects"}, runs, and
                artifacts. There is no recovery.
              </p>
              <details className="group">
                <summary className="inline-flex h-[30px] cursor-pointer list-none items-center justify-center self-start rounded-[5px] border border-fail/30 bg-fail-soft px-[11px] text-[13px] font-medium text-fail transition-colors hover:bg-fail/20 [&::-webkit-details-marker]:hidden">
                  Delete team
                </summary>
                <form
                  action={`${here}?deleteTeam`}
                  className="mt-4 flex flex-col gap-3 border-fail/20 border-t pt-4"
                  method="post"
                >
                  {dangerError && (
                    <Alert variant="error">
                      <AlertDescription>{dangerError}</AlertDescription>
                    </Alert>
                  )}
                  <p className="text-[length:var(--text-fs-13)] text-fg-3 leading-relaxed">
                    Type{" "}
                    <code className="rounded-sm bg-bg-3 px-1 py-0.5 font-mono text-[11px] text-fg-1">
                      {team.slug}
                    </code>{" "}
                    below to confirm.
                  </p>
                  <Input
                    autoComplete="off"
                    className="font-mono"
                    name="confirm"
                    nativeInput
                    placeholder={team.slug}
                    required
                  />
                  <Button
                    className="self-start"
                    size="sm"
                    type="submit"
                    variant="destructive"
                  >
                    Permanently delete
                  </Button>
                </form>
              </details>
            </div>
          </SettingsCard>
        </>
      )}
    </SettingsPage>
  );
}
