import { asc, db } from "void/db";
import { testAnnotations, testResultAttempts, testTags } from "@schema";
import { childByTestResultWhere, type TenantScope } from "@/lib/scope";

/**
 * The three run-scoped child reads a test-result detail view needs — tags,
 * annotations, and per-attempt rows (error message/stack + captured
 * stdout/stderr) — as one project-scoped batch.
 *
 * Both the test-detail page loader (`pages/…/tests/[testResultId]`) and the
 * MCP `get_test_result` tool (`src/lib/mcp/queries.ts`) render the same three
 * lists with the same projections; keeping the queries here means the column
 * shapes and the `childByTestResultWhere` scoping can't drift between the two
 * surfaces. Each caller fires this alongside its own extra reads (quarantine /
 * run metadata for the page, the artifact index for MCP), so the fan-out stays
 * concurrent.
 *
 * `tags` is returned as `{ tag }` rows (not a flat `string[]`) so the page
 * loader can hand them to the client untouched; the MCP tool flattens.
 */
export async function loadTestResultChildren(
  scope: TenantScope,
  testResultId: string,
) {
  const [tags, annotations, attempts] = await Promise.all([
    db
      .select({ tag: testTags.tag })
      .from(testTags)
      .where(childByTestResultWhere(testTags, scope, testResultId)),
    db
      .select({
        type: testAnnotations.type,
        description: testAnnotations.description,
      })
      .from(testAnnotations)
      .where(childByTestResultWhere(testAnnotations, scope, testResultId)),
    db
      .select({
        attempt: testResultAttempts.attempt,
        status: testResultAttempts.status,
        durationMs: testResultAttempts.durationMs,
        errorMessage: testResultAttempts.errorMessage,
        errorStack: testResultAttempts.errorStack,
        // Captured per-attempt logs — surfaced by the `get_test_result` MCP tool
        // (via loadMcpTestResultDetail, which passes children.attempts straight
        // through) and the test-detail page so agents/humans see `console.log`
        // CI output alongside each attempt's error.
        stdout: testResultAttempts.stdout,
        stderr: testResultAttempts.stderr,
      })
      .from(testResultAttempts)
      .where(childByTestResultWhere(testResultAttempts, scope, testResultId))
      .orderBy(asc(testResultAttempts.attempt)),
  ]);
  return { tags, annotations, attempts };
}
