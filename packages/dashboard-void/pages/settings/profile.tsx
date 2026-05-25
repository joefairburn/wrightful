import type { Props } from "./profile.server";

/**
 * Settings → Profile. Read-only summary of the signed-in user. Wrapped by
 * `pages/settings/layout.tsx` for the chrome.
 */
export default function SettingsProfilePage({ user }: Props) {
  return (
    <div className="mx-auto w-full max-w-3xl p-6 sm:p-8">
      <header className="mb-6 border-border/50 border-b pb-5">
        <h1 className="font-semibold text-2xl tracking-tight">Profile</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {user.name}{" "}
          <span className="font-mono text-muted-foreground/70">
            · {user.email}
          </span>
        </p>
      </header>
    </div>
  );
}
