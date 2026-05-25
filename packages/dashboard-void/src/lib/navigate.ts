import { useRouter } from "@void/react";

/**
 * Programmatic SPA navigation hook. Replaces `rwsdk/client#navigate`.
 *
 * Old call sites used a free function `navigate(href, { history: "replace" })`.
 * Void's router is hook-scoped via `useRouter()`. Each consumer calls
 * `const navigate = useNavigate()` at the top of the component, then
 * `navigate(href, opts)` inside event handlers — preserves the shape.
 */
export interface NavigateOptions {
  /** rwsdk's `{ history: "replace" }` → Void's `{ replace: true }`. */
  history?: "push" | "replace";
}

export function useNavigate(): (href: string, opts?: NavigateOptions) => void {
  const router = useRouter();
  return (href: string, opts?: NavigateOptions) => {
    void router.visit(href, {
      replace: opts?.history === "replace",
    });
  };
}
