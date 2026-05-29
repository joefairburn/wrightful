import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { getSession } from "void/auth";

export type Props = InferProps<typeof loader>;

/**
 * Login page loader. Bounces authenticated users back to `/` so they don't
 * see the sign-in form again. Surfaces the runtime feature flags
 * (GitHub OAuth wired? open signup allowed?) needed to render the page.
 */
export const loader = defineHandler(async (c) => {
  const session = getSession();
  if (session) {
    return c.redirect("/");
  }
  const githubEnabled = Boolean(
    env.AUTH_GITHUB_CLIENT_ID && env.AUTH_GITHUB_CLIENT_SECRET,
  );
  return {
    githubEnabled,
    signupAllowed: env.ALLOW_OPEN_SIGNUP,
  };
});
