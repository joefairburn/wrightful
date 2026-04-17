"use client";

import { Button } from "@/app/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function LoginGithubButton({ callbackURL }: { callbackURL: string }) {
  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full"
      onClick={() => {
        void authClient.signIn.social({ provider: "github", callbackURL });
      }}
    >
      Continue with GitHub
    </Button>
  );
}
