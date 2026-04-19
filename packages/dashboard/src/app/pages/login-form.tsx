"use client";

import { Info } from "lucide-react";
import { useState } from "react";
import { navigate } from "rwsdk/client";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { safeNextPath } from "@/lib/safe-next-path";

type Mode = "signin" | "signup";

const PASSWORD_MIN = 12;

const labelClass = "font-label text-sm text-foreground";

export function LoginForm({
  mode,
  callbackURL,
}: {
  mode: Mode;
  callbackURL: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isSignup = mode === "signup";

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);
    const getField = (key: string): string => {
      const v = formData.get(key);
      return typeof v === "string" ? v : "";
    };
    const email = getField("email");
    const password = getField("password");
    const name = getField("name");

    if (isSignup) {
      if (password.length < PASSWORD_MIN || !/\d/.test(password)) {
        setError(
          `Password must be at least ${PASSWORD_MIN} characters and include a number.`,
        );
        return;
      }
    }

    setPending(true);
    const promise = isSignup
      ? authClient.signUp.email({ email, password, name, callbackURL })
      : authClient.signIn.email({ email, password, callbackURL });

    promise
      .then((result) => {
        if (result.error) {
          setError(result.error.message ?? "Something went wrong.");
          setPending(false);
          return;
        }
        void navigate(safeNextPath(callbackURL));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setPending(false);
      });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {isSignup && (
        <div className="flex flex-col gap-2">
          <label htmlFor="name" className={labelClass}>
            Name
          </label>
          <Input nativeInput id="name" name="name" required maxLength={80} />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor="email" className={labelClass}>
          Email address
        </label>
        <Input
          nativeInput
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          placeholder="you@example.com"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="password" className={labelClass}>
          Password
        </label>
        <Input
          nativeInput
          id="password"
          name="password"
          type="password"
          autoComplete={isSignup ? "new-password" : "current-password"}
          required
          minLength={isSignup ? PASSWORD_MIN : undefined}
        />
        {isSignup && (
          <div className="flex items-start gap-2 mt-1">
            <Info
              size={14}
              className="text-muted-foreground shrink-0 mt-0.5"
              aria-hidden
            />
            <p className="font-label text-xs text-muted-foreground leading-tight">
              Must be at least {PASSWORD_MIN} characters long and contain at
              least one number.
            </p>
          </div>
        )}
      </div>

      {error && (
        <Alert variant="error" role="alert" aria-live="polite">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={pending} className="mt-2 w-full">
        {isSignup
          ? pending
            ? "Creating account…"
            : "Create account"
          : pending
            ? "Signing in…"
            : "Sign in"}
      </Button>
    </form>
  );
}
