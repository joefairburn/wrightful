import { defineHandler, type InferProps } from "void";

export type Props = InferProps<typeof loader>;

/**
 * Reset-password loader. Better Auth's reset link hits its own
 * `/api/auth/reset-password/:token` endpoint, which validates the token and
 * then redirects HERE with either `?token=…` (valid) or `?error=…` (expired /
 * already used). We surface both to the page so it can show the form or an
 * "invalid link" message. No session gate — a logged-out user following the
 * link must still be able to reset.
 */
export const loader = defineHandler((c) => {
  return {
    token: c.req.query("token") ?? null,
    tokenError: c.req.query("error") ?? null,
  };
});
