import { isValid, parse, parseISO } from "date-fns";
import type { ExpressionBuilder, ExpressionWrapper, SqlBool } from "kysely";
import type { TenantDatabase } from "@/tenant";

export const RUN_STATUSES = [
  "passed",
  "failed",
  "flaky",
  "timedout",
  "interrupted",
  "skipped",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const DEFAULT_PAGE_SIZE = 20;

export type RunsFilters = {
  q: string;
  status: RunStatus[];
  branch: string[];
  actor: string[];
  environment: string[];
  from: string | null;
  to: string | null;
  page: number;
};

export const EMPTY_FILTERS: RunsFilters = {
  q: "",
  status: [],
  branch: [],
  actor: [],
  environment: [],
  from: null,
  to: null,
  page: 1,
};

// Cap per-filter value count. Each entry becomes a bound param in an
// `in (...)` clause; 50 leaves comfortable headroom for the query's
// other conditions and keeps the generated SQL small.
const MAX_FILTER_VALUES = 50;

function readList(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .slice(0, MAX_FILTER_VALUES);
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return isValid(parse(s, "yyyy-MM-dd", new Date()));
}

function parsePage(raw: string | null): number {
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

export function parseRunsFilters(params: URLSearchParams): RunsFilters {
  const statusRaw = readList(params, "status");
  const statusSet: ReadonlySet<string> = new Set(RUN_STATUSES);
  const status = statusRaw.filter((s): s is RunStatus => statusSet.has(s));
  const from = params.get("from");
  const to = params.get("to");
  return {
    q: params.get("q")?.trim() ?? "",
    status,
    branch: readList(params, "branch"),
    actor: readList(params, "actor"),
    environment: readList(params, "env"),
    from: from && isValidIsoDate(from) ? from : null,
    to: to && isValidIsoDate(to) ? to : null,
    page: parsePage(params.get("page")),
  };
}

export function toSearchParams(filters: RunsFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status.length > 0) params.set("status", filters.status.join(","));
  if (filters.branch.length > 0) params.set("branch", filters.branch.join(","));
  if (filters.actor.length > 0) params.set("actor", filters.actor.join(","));
  if (filters.environment.length > 0)
    params.set("env", filters.environment.join(","));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.page > 1) params.set("page", String(filters.page));
  return params;
}

export function hasAnyFilter(filters: RunsFilters): boolean {
  return (
    filters.q.length > 0 ||
    filters.status.length > 0 ||
    filters.branch.length > 0 ||
    filters.actor.length > 0 ||
    filters.environment.length > 0 ||
    filters.from !== null ||
    filters.to !== null
  );
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Predicate builder for `db.selectFrom("runs")` scoped to a project and the
 * supplied filters. Caller applies via
 *   `.where((eb) => buildRunsWhere(eb, projectId, filters))`.
 *
 * Always pins `committed = 1` so in-flight / uncommitted rows stay hidden
 * — replaces the pre-M3 `committedRuns` view.
 *
 * Timestamps are stored as unix seconds; date-range filters convert the
 * ISO YYYY-MM-DD bounds to seconds at the UTC day boundary.
 */
export function buildRunsWhere(
  eb: ExpressionBuilder<TenantDatabase, "runs">,
  projectId: string,
  filters: RunsFilters,
): ExpressionWrapper<TenantDatabase, "runs", SqlBool> {
  const clauses: ExpressionWrapper<TenantDatabase, "runs", SqlBool>[] = [
    eb("runs.projectId", "=", projectId),
    eb("runs.committed", "=", 1),
  ];

  if (filters.status.length > 0) {
    clauses.push(eb("runs.status", "in", filters.status));
  }
  if (filters.branch.length > 0) {
    clauses.push(eb("runs.branch", "in", filters.branch));
  }
  if (filters.actor.length > 0) {
    clauses.push(eb("runs.actor", "in", filters.actor));
  }
  if (filters.environment.length > 0) {
    clauses.push(eb("runs.environment", "in", filters.environment));
  }
  if (filters.from) {
    const fromSeconds = Math.floor(
      parseISO(`${filters.from}T00:00:00.000Z`).getTime() / 1000,
    );
    clauses.push(eb("runs.createdAt", ">=", fromSeconds));
  }
  if (filters.to) {
    const toSeconds = Math.floor(
      parseISO(`${filters.to}T23:59:59.999Z`).getTime() / 1000,
    );
    clauses.push(eb("runs.createdAt", "<=", toSeconds));
  }
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    clauses.push(
      eb.or([
        eb("runs.commitMessage", "like", pattern),
        eb("runs.commitSha", "like", pattern),
        eb("runs.branch", "like", pattern),
      ]),
    );
  }

  return eb.and(clauses);
}
