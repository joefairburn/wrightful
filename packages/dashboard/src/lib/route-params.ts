import { requestInfo } from "rwsdk/worker";

/**
 * Read a string route parameter from the current request. rwsdk's DefaultAppContext
 * types params loosely; this helper isolates the one necessary cast so pages can
 * just call `param("runId")` without a cast in every file.
 */
export function param(key: string): string {
  const params = requestInfo.params as Record<string, unknown>;
  return String(params[key]);
}
