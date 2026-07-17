// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

const h = await vi.hoisted(async () => {
  const schema = await import("../../db/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  return {
    db,
    client: {
      exec: (s: string) => client.exec(s),
      close: () => client.close(),
    },
  };
});

vi.mock("void/db", async () => {
  const ops = await vi.importActual<Record<string, unknown>>("void/_db");
  return { ...ops, db: h.db };
});
vi.mock("void/env", () => ({ env: { WRIGHTFUL_MAX_TEST_RESULTS_PER_RUN: 3 } }));
vi.mock("@/realtime/publish", () => ({
  broadcastRunRoom: () => Promise.resolve(),
  broadcastProjectRoom: () => Promise.resolve(),
}));

const { appendRunResults } = await import("@/lib/ingest");
const { makeTenantScope } = await import("@/lib/scope");
const { runs } = await import("../../db/schema");
const { getTableConfig } = await import("void/schema-pg");

function pgType(columnType: string): string {
  if (columnType.includes("BigInt")) return "bigint";
  if (columnType.includes("Integer")) return "integer";
  if (columnType.includes("Jsonb")) return "jsonb";
  return "text";
}
function createTableSql(table: Parameters<typeof getTableConfig>[0]): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const parts = [`"${c.name}"`, pgType(c.columnType)];
    if (c.primary) parts.push("primary key");
    if (c.notNull && !c.primary) parts.push("not null");
    return parts.join(" ");
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const SCOPE = makeTenantScope({
  teamId: "team-1",
  projectId: "proj-1",
  teamSlug: "acme",
  projectSlug: "web",
});
const NOW = 1_000_000;

async function seedRun(id: string, totalTests: number) {
  await h.db.insert(runs).values({
    id,
    teamId: SCOPE.teamId,
    projectId: SCOPE.projectId,
    idempotencyKey: id,
    totalTests,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    durationMs: 0,
    status: "running",
    origin: "ci",
    createdAt: NOW,
    lastActivityAt: NOW,
    completedAt: null,
  } as never);
}

function batch() {
  return {
    results: [
      {
        testId: "t-new",
        title: "adds",
        file: "math.spec.ts",
        status: "passed" as const,
        durationMs: 1,
        retryCount: 0,
        attempts: [{ attempt: 0, status: "passed" as const, durationMs: 1 }],
        tags: [],
        annotations: [],
      },
    ],
  };
}

beforeAll(async () => {
  for (const t of [runs]) {
    const { name } = getTableConfig(t);
    await h.client.exec(`drop table if exists "${name}" cascade;`);
    await h.client.exec(createTableSql(t));
  }
});
afterAll(async () => {
  await h.client.close();
});
beforeEach(async () => {
  const { name } = getTableConfig(runs);
  await h.client.exec(`delete from "${name}";`);
});

describe("appendRunResults — per-run row cap", () => {
  it("refuses appends once totalTests reaches the ceiling (413-mapped rowCapExceeded)", async () => {
    await seedRun("run-cap", 3);
    const outcome = await appendRunResults(SCOPE, "run-cap", batch(), NOW);
    expect(outcome).toEqual({ kind: "rowCapExceeded", limit: 3, count: 3 });
  });

  it("refuses when already over the ceiling", async () => {
    await seedRun("run-over", 9);
    const outcome = await appendRunResults(SCOPE, "run-over", batch(), NOW);
    expect(outcome.kind).toBe("rowCapExceeded");
  });
});
