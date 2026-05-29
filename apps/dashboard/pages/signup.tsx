import { useState } from "react";
import { auth } from "void/client";
import { Link, useRouter } from "@void/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Props } from "./signup.server";

/**
 * Open-signup page (email + password). Mirrors `login.tsx`; reachable only when
 * `ALLOW_OPEN_SIGNUP` is enabled (the colocated loader bounces to /login
 * otherwise). Authenticated users are redirected to `/` by the loader.
 */
export default function SignupPage({ githubEnabled }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await auth.signUp.email({ name, email, password });
      if (result?.error) {
        setError(result.error.message ?? "Sign-up failed");
        return;
      }
      void router.visit("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-up failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 p-6">
      <header className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold">
          Create your Wrightful account
        </h1>
        <p className="text-muted-foreground text-sm">
          Get started in a few seconds.
        </p>
      </header>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            type="text"
            value={name}
            required
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            required
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            required
            minLength={8}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Creating account…" : "Create account"}
        </Button>
      </form>

      {githubEnabled && (
        <div className="space-y-2">
          <div className="bg-border h-px" />
          <a
            href="/api/auth/sign-in/social?provider=github"
            className="bg-foreground text-background block rounded-md px-4 py-2 text-center text-sm font-medium"
          >
            Continue with GitHub
          </a>
        </div>
      )}

      <p className="text-center text-sm">
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
