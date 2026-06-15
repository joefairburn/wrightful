import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { getSession } from "void/auth";

export type Props = InferProps<typeof loader>;

/**
 * Forgot-password loader. Anonymous-only (authed users bounce to `/`). Password
 * reset needs an email sender — when `EMAIL_FROM` is unset the request can't be
 * fulfilled, so the page bounces to `/login` rather than pretending to send
 * (the colocated `resetEnabled` flag on `/login` also hides the entry link).
 */
export const loader = defineHandler((c) => {
  const session = getSession();
  if (session) {
    return c.redirect("/");
  }
  if (!env.EMAIL_FROM) {
    return c.redirect("/login");
  }
  return {};
});
