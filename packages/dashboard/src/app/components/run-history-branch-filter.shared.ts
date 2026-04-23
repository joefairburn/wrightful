/**
 * URL sentinel for "don't filter by branch". Picked to be unambiguously
 * distinct from any real git branch name.
 *
 * Lives in a plain module (not the "use client" filter component) so that
 * server-side imports get the actual string, not an RSC client reference.
 */
export const ALL_BRANCHES = "__all__";
