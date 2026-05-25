import { useState } from "react";
import { auth } from "void/client";
import { Link, useRouter } from "@void/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Props } from "./login.server";

/**
 * Login page. Uses `void/client`'s preconfigured Better Auth client for
 * email/password sign-in and (when configured) GitHub OAuth.
 *
 * Anonymous users only — server redirects authenticated users to `/` via
 * the colocated loader.
 */
export default function LoginPage({ githubEnabled, signupAllowed }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await auth.signIn.email({ email, password });
      if (result?.error) {
        setError(result.error.message ?? "Sign-in failed");
        return;
      }
      void router.visit("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 p-6">
      <header className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold">Sign in to Wrightful</h1>
        <p className="text-muted-foreground text-sm">
          Welcome back. Continue to the dashboard.
        </p>
      </header>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
      >
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
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Continue"}
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

      {signupAllowed && (
        <p className="text-center text-sm">
          No account yet?{" "}
          <Link href="/signup" className="underline">
            Create one
          </Link>
        </p>
      )}
    </main>
  );
}
