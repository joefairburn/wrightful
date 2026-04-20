import { requestInfo } from "rwsdk/worker";
import { hasGithubOAuthConfigured } from "@/lib/better-auth";
import { safeNextPath } from "@/lib/safe-next-path";
import { LoginForm } from "./login-form";
import { LoginGithubButton } from "./login-github-button";

export function LoginPage() {
  const url = new URL(requestInfo.request.url);
  const next = safeNextPath(url.searchParams.get("next"));
  const callbackURL = encodeURIComponent(next);
  const mode =
    url.pathname === "/signup" || url.searchParams.get("mode") === "signup"
      ? "signup"
      : "signin";
  const showGithub = hasGithubOAuthConfigured();
  const errorCode = url.searchParams.get("error");
  const errorCopy = {
    not_allowed:
      "Your account isn't on the allow-list for this Wrightful instance. Contact the team owner for an invite.",
  }[errorCode ?? ""];

  const copy = {
    signin: {
      title: "Sign in",
      subtitle: "Access your test dashboard",
      switchText: "Need an account? Sign up",
      switchHref: `/signup?next=${callbackURL}`,
    },
    signup: {
      title: "Create your account",
      subtitle: "Sign up to access this Wrightful instance",
      switchText: "Already have an account? Sign in",
      switchHref: `/login?next=${callbackURL}`,
    },
  }[mode];

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-[400px] bg-card rounded-xl flex flex-col p-8">
        <div className="mb-10 text-center">
          <h1 className="font-medium text-2xl tracking-tighter text-foreground mb-2">
            {copy.title}
          </h1>
          <p className="font-label text-sm text-muted-foreground">
            {copy.subtitle}
          </p>
        </div>

        {errorCopy && (
          <div
            role="alert"
            className="mb-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive-foreground"
          >
            {errorCopy}
          </div>
        )}

        {showGithub && (
          <>
            <div className="flex flex-col gap-3 mb-8">
              <LoginGithubButton callbackURL={next} />
            </div>
            <div className="flex items-center gap-4 mb-8">
              <div className="h-px bg-secondary flex-grow" />
              <span className="font-label text-xs text-muted-foreground uppercase tracking-widest">
                Or
              </span>
              <div className="h-px bg-secondary flex-grow" />
            </div>
          </>
        )}

        <LoginForm mode={mode} callbackURL={next} />

        <div className="mt-8 text-center">
          <a
            href={copy.switchHref}
            className="font-label text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {copy.switchText}
          </a>
        </div>
      </div>
    </main>
  );
}
