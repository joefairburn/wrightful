import { requestInfo } from "rwsdk/worker";
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/app/components/ui/card";
import { Separator } from "@/app/components/ui/separator";
import { hasGithubOAuthConfigured } from "@/lib/better-auth";
import { LoginForm } from "./login-form";
import { LoginGithubButton } from "./login-github-button";

export function LoginPage() {
  const url = new URL(requestInfo.request.url);
  const next = url.searchParams.get("next") ?? "/";
  const callbackURL = encodeURIComponent(next);
  const mode = url.searchParams.get("mode") === "signup" ? "signup" : "signin";
  const showGithub = hasGithubOAuthConfigured();

  return (
    <div className="mx-auto max-w-sm px-6 py-16">
      <Card>
        <CardHeader>
          <CardTitle className="text-center">
            {mode === "signup" ? "Create an account" : "Sign in to Wrightful"}
          </CardTitle>
          <CardDescription className="text-center">
            {mode === "signup"
              ? "Set up a password to get started."
              : "Welcome back."}
          </CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-col gap-4">
          <LoginForm mode={mode} callbackURL={next} />

          <p className="text-center text-muted-foreground text-sm">
            {mode === "signup" ? (
              <>
                Have an account?{" "}
                <a
                  href={`/login?next=${callbackURL}`}
                  className="text-foreground underline-offset-4 hover:underline"
                >
                  Sign in
                </a>
              </>
            ) : (
              <>
                New to Wrightful?{" "}
                <a
                  href={`/login?mode=signup&next=${callbackURL}`}
                  className="text-foreground underline-offset-4 hover:underline"
                >
                  Create an account
                </a>
              </>
            )}
          </p>

          {showGithub && (
            <>
              <div className="flex items-center gap-3 text-muted-foreground text-xs">
                <Separator className="flex-1" />
                or
                <Separator className="flex-1" />
              </div>
              <LoginGithubButton callbackURL={next} />
            </>
          )}
        </CardPanel>
      </Card>
    </div>
  );
}
