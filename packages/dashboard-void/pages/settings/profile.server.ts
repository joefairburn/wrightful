import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";

export type Props = InferProps<typeof loader>;

/**
 * Settings → Profile loader. Read-only page showing the signed-in user's
 * name + email. The user's teams for the sidebar come from `useShared()`,
 * populated by `middleware/01.context.ts`.
 */
export const loader = defineHandler(async (c) => {
  const user = requireAuth(c);
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image ?? null,
    },
  };
});
