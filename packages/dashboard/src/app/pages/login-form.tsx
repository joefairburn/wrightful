"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/app/components/ui/alert";
import { Button } from "@/app/components/ui/button";
import { Field, FieldLabel } from "@/app/components/ui/field";
import { Input } from "@/app/components/ui/input";
import { authClient } from "@/lib/auth-client";

type Mode = "signin" | "signup";

export function LoginForm({
  mode,
  callbackURL,
}: {
  mode: Mode;
  callbackURL: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = event.currentTarget;
    const email = (form.elements.namedItem("email") as HTMLInputElement).value;
    const password = (form.elements.namedItem("password") as HTMLInputElement)
      .value;
    const nameEl = form.elements.namedItem("name") as HTMLInputElement | null;
    const name = nameEl?.value ?? "";

    const promise =
      mode === "signup"
        ? authClient.signUp.email({ email, password, name, callbackURL })
        : authClient.signIn.email({ email, password, callbackURL });

    promise
      .then((result) => {
        if (result.error) {
          setError(result.error.message ?? "Something went wrong.");
          setPending(false);
          return;
        }
        window.location.href = callbackURL;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setPending(false);
      });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
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
      <Button
        type="submit"
        size="lg"
        className="mt-2 w-full"
        disabled={pending}
      >
        {mode === "signup"
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
