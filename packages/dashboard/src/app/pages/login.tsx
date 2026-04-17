import { requestInfo } from "rwsdk/worker";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/app/components/ui/card";
import { Field, FieldLabel } from "@/app/components/ui/field";
import { Input } from "@/app/components/ui/input";
import { Separator } from "@/app/components/ui/separator";
import { hasGithubOAuthConfigured } from "@/lib/better-auth";
import { LoginGithubButton } from "./login-github-button";

export function LoginPage() {
  const url = new URL(requestInfo.request.url);
  const next = url.searchParams.get("next") ?? "/";
  const callbackURL = encodeURIComponent(next);
  const mode = url.searchParams.get("mode") === "signup" ? "signup" : "signin";
  const error = url.searchParams.get("error");
  const showGithub = hasGithubOAuthConfigured();

  const formAction =
    mode === "signup" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";

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
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <form
            method="post"
            action={formAction}
            className="flex flex-col gap-3"
          >
            <input type="hidden" name="callbackURL" value={next} />
            {mode === "signup" && (
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input nativeInput name="name" required maxLength={80} />
              </Field>
            )}
            <Field>
              <FieldLabel>Email</FieldLabel>
              <Input nativeInput name="email" type="email" required />
            </Field>
            <Field>
              <FieldLabel>Password</FieldLabel>
              <Input
                nativeInput
                name="password"
                type="password"
                required
                minLength={8}
              />
            </Field>
            <Button type="submit" size="lg" className="mt-2 w-full">
              {mode === "signup" ? "Create account" : "Sign in"}
            </Button>
          </form>

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
