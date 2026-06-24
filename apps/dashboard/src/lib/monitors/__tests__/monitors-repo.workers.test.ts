import { describe, expect, it } from "vite-plus/test";
import { inFlightExecutionWhere } from "@/lib/monitors/monitors-repo";
import { makeTenantScope } from "@/lib/scope";
import { monitorExecutions } from "@schema";

/**
 * `inFlightExecutionWhere` is the manual-run ("run now") twin of the scheduler's
 * `dueMonitorsWhere` NOT EXISTS arm — the single predicate that decides whether
 * a monitor already has an execution in flight, so `enqueueManualExecution`
 * refuses to stack a second container. Under the `void/db` stub, operators
 * record their arguments (`{ __op, args }`), so we read back the EXACT predicate
 * and pin its two invariants:
 *
 *  1. tenant isolation — it ANDs `projectId` (bound to the scope's auth-checked
 *     id) so a leaked monitor id can't probe another project's executions;
 *  2. the in-flight definition — `monitorId` matches AND `state IN
 *     ('queued','running')` (never a terminal state, which would wrongly block a
 *     fresh run forever).
 */

interface RecordedOp {
  __op: string;
  args: readonly unknown[];
}
interface RecordedColumn {
  name?: unknown;
}

const scope = makeTenantScope({
  teamId: "team_abc",
  projectId: "proj_xyz",
  teamSlug: "acme",
  projectSlug: "web",
});

describe("inFlightExecutionWhere", () => {
  it("ANDs projectId + monitorId + the non-terminal state set, in that order", () => {
    const where = inFlightExecutionWhere(
      scope,
      "mon-1",
    ) as unknown as RecordedOp;

    expect(where.__op).toBe("and");
    expect(where.args).toHaveLength(3);
    const [project, monitor, state] = where.args as [
      RecordedOp,
      RecordedOp,
      RecordedOp,
    ];

    expect(project.__op).toBe("eq");
    expect((project.args[0] as RecordedColumn).name).toBe("projectId");
    expect(project.args[1]).toBe("proj_xyz");

    expect(monitor.__op).toBe("eq");
    expect((monitor.args[0] as RecordedColumn).name).toBe("monitorId");
    expect(monitor.args[1]).toBe("mon-1");

    // The in-flight arm: only the two non-terminal states — never pass/fail/
    // degraded/error, so a settled history can't block a fresh manual run.
    expect(state.__op).toBe("inArray");
    expect(state.args[0]).toBe(monitorExecutions.state);
    expect(state.args[1]).toEqual(["queued", "running"]);
  });
});
