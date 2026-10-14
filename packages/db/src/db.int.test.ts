import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "./testing";
import { auditEvents, files, organizations, spaces, users } from "./schema";
import { scoped } from "./scoped";

let t: TestDatabase;

/** Drizzle wraps driver errors ("Failed query: …"); the Postgres message is on `cause`. */
async function pgError(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return `${e.message} ${e.cause?.message ?? ""}`;
  }
  throw new Error("expected the query to fail");
}

beforeAll(async () => {
  t = await createTestDatabase();
  await t.db.insert(organizations).values([
    { id: "org_a", name: "Alpha", slug: "alpha" },
    { id: "org_b", name: "Beta", slug: "beta" },
  ]);
  await t.db.insert(users).values({ id: "user_1", name: "Ana", email: "ana@example.com" });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe("migrations", () => {
  it("create every table from §6 and the pgvector extension", async () => {
    const rows = await t.db.execute<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public'`);
    const names = rows.map((r) => r.table_name);
    for (const table of [
      "users", "sessions", "accounts", "verifications", "organizations", "memberships", "invitations",
      "spaces", "files", "versions", "rules", "plans", "plan_steps", "audit_events", "trash_items",
      "shares", "api_keys", "ai_usage", "subscriptions", "notifications",
    ]) expect(names).toContain(table);
    const ext = await t.db.execute<{ extname: string }>(sql`select extname from pg_extension where extname = 'vector'`);
    expect(ext).toHaveLength(1);
  });
});

describe("audit_events is append-only", () => {
  it("allows INSERT but rejects UPDATE, DELETE and TRUNCATE", async () => {
    const [ev] = await t.db.insert(auditEvents).values({ organizationId: "org_a", actor: "user:user_1", action: "move", reason: "test" }).returning();
    expect(await pgError(t.db.update(auditEvents).set({ reason: "tampered" }).where(eq(auditEvents.id, ev!.id)))).toMatch(/append-only: UPDATE/);
    expect(await pgError(t.db.delete(auditEvents).where(eq(auditEvents.id, ev!.id)))).toMatch(/append-only: DELETE/);
    expect(await pgError(t.db.execute(sql`truncate audit_events`))).toMatch(/append-only: TRUNCATE/);
    const [still] = await t.db.select().from(auditEvents).where(eq(auditEvents.id, ev!.id));
    expect(still?.reason).toBe("test");
  });

  it("records undo as a new event and exposes undone_by through the view", async () => {
    const [orig] = await t.db.insert(auditEvents).values({ organizationId: "org_a", actor: "agent:user_1", action: "rename" }).returning();
    await t.db.insert(auditEvents).values({ organizationId: "org_a", actor: "user:user_1", action: "undo", undoesEventId: orig!.id });
    const rows = await t.db.execute<{ id: string; undone_by: string | null }>(sql`select id, undone_by from audit_events_with_undo where id = ${orig!.id}`);
    expect(rows[0]?.undone_by).toBe("user:user_1");
  });
});

describe("files.embedding (pgvector)", () => {
  it("round-trips a 1024-dimensional vector and supports cosine distance", async () => {
    const [space] = await t.db.insert(spaces).values({ organizationId: "org_a", name: "Local", mode: "private", adapterId: "local-server", rootRef: "/data" }).returning();
    const v = Array.from({ length: 1024 }, (_, i) => (i % 7) / 7);
    const [f] = await t.db.insert(files).values({ organizationId: "org_a", spaceId: space!.id, providerRef: "a.pdf", path: "a.pdf", name: "a.pdf", embedding: v }).returning();
    expect(f!.embedding).toHaveLength(1024);
    expect(f!.embedding![6]).toBeCloseTo(6 / 7, 5);
    const d = await t.db.execute<{ d: number }>(sql`select embedding <=> ${JSON.stringify(v)}::vector as d from files where id = ${f!.id}`);
    expect(Number(d[0]!.d)).toBeCloseTo(0, 6);
  });
});

describe("scoped() data access", () => {
  it("never returns or modifies another organization's rows", async () => {
    const a = scoped(t.db, "org_a");
    const b = scoped(t.db, "org_b");
    await b.insert(spaces, { name: "Beta drive", mode: "connect", adapterId: "gdrive", rootRef: "root" });
    const mine = await a.select(spaces);
    expect(mine.every((s) => s.organizationId === "org_a")).toBe(true);
    expect(mine.some((s) => s.name === "Beta drive")).toBe(false);

    // Updates through A's scope can't reach B's rows, even with a matching condition.
    const touched = await a.update(spaces, eq(spaces.name, "Beta drive"), { name: "hijacked" });
    expect(touched).toHaveLength(0);
    expect((await b.first(spaces, eq(spaces.name, "Beta drive")))?.name).toBe("Beta drive");
  });

  it("forces the scope's organization on insert", async () => {
    const a = scoped(t.db, "org_a");
    const row = await a.insert(spaces, { name: "Sneaky", mode: "cloud", adapterId: "fp-cloud", rootRef: "x", organizationId: "org_b" } as never);
    expect(row.organizationId).toBe("org_a");
  });

  it("refuses an empty organization id", () => {
    expect(() => scoped(t.db, "")).toThrow();
  });
});
