import { isValid, parse, parseISO } from "date-fns";
import { and, eq, gte, inArray, like, lte, or, type SQL } from "drizzle-orm";
import { committedRuns } from "@/db/schema";

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

function readList(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
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

export function buildRunsWhere(
  projectId: string,
  filters: RunsFilters,
): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    eq(committedRuns.projectId, projectId),
  ];

  if (filters.status.length > 0) {
    conditions.push(inArray(committedRuns.status, filters.status));
  }
  if (filters.branch.length > 0) {
    conditions.push(inArray(committedRuns.branch, filters.branch));
  }
  if (filters.actor.length > 0) {
    conditions.push(inArray(committedRuns.actor, filters.actor));
  }
  if (filters.environment.length > 0) {
    conditions.push(inArray(committedRuns.environment, filters.environment));
  }
  if (filters.from) {
    const fromDate = parseISO(`${filters.from}T00:00:00.000Z`);
    conditions.push(gte(committedRuns.createdAt, fromDate));
  }
  if (filters.to) {
    const toDate = parseISO(`${filters.to}T23:59:59.999Z`);
    conditions.push(lte(committedRuns.createdAt, toDate));
  }
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    const searchCondition = or(
      like(committedRuns.commitMessage, pattern),
      like(committedRuns.commitSha, pattern),
      like(committedRuns.branch, pattern),
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  return and(...conditions);
}
