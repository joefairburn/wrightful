/**
 * URL builder. Replaces the old `link()` helper from `@/app/links` (rwsdk's
 * typed route builder) with a runtime parameter substitution.
 *
 * Old call style:
 *   link("/t/:teamSlug", { teamSlug: "foo" })            // → /t/foo
 *   link("/t/:teamSlug/p/:projectSlug", { ... })
 *   link("/settings/teams/new")
 *
 * Void exposes typed route paths via `void/routes` but doesn't have a
 * typed-builder API in the same shape. Until we migrate the call sites to
 * `<Link href="...">` literals or wrap `useRouter()`, this string-substitution
 * shim preserves the existing call shape with no type-safety regression
 * beyond what was already there (the rwsdk version inferred patterns at
 * build time; this version is dynamic).
 */

type Params = Record<string, string | number>;

function substitute(pattern: string, params?: Params): string {
  if (!params) return pattern;
  return pattern.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, name) => {
    const v = params[name];
    if (v === undefined) {
      throw new Error(`link(): missing param :${name} for pattern ${pattern}`);
    }
    return encodeURIComponent(String(v));
  });
}

export function link(pattern: string, params?: Params): string {
  return substitute(pattern, params);
}
