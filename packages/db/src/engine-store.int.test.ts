import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createEngine, type Approver, type EngineStore } from "@folderpilot/core";
import { MemoryAdapter } from "@folderpilot/core/testing";
import { createTestDatabase, type TestDatabase } from "./testing";
import { createPgEngineStore } from "./engine-store";
import { auditEvents, files, organizations, planSteps, spaces, trashItems, users } from "./schema";

let t: TestDatabase;
let spaceA: string;
let spaceB: string;
const owner: Approver = { userId: "user_1", role: "owner" };

/** Index everything the adapter holds into `files` for one space. */
async function index(adapter: MemoryAdapter, org: string, spaceId: string) {
  const ids = new Map<string, string>();
  for (const path of adapter.paths()) {
    const e = adapter.entryAt(path);
    const [row] = await t.db
      .insert(files)
      .values({ organizationId: org, spaceId, providerRef: e.ref.id, path, name: e.name, ext: e.name.split(".").pop() ?? "", size: e.size, version: e.version, mtime: new Date(e.mtime) })
      .returning();
    ids.set(path, row!.id);
  }
  return ids;
}

beforeAll(async () => {
  t = await createTestDatabase("fp_engine");
  await t.db.insert(organizations).values([
    { id: "org_a", name: "Alpha", slug: "alpha" },
    { id: "org_b", name: "Beta", slug: "beta" },
  ]);
  await t.db.insert(users).values({ id: "user_1", name: "Ana", email: "ana@example.com" });
}, 60_000);

// Fresh spaces per test (the in-memory adapters reuse provider ids).
beforeEach(async () => {
  const [a, b] = await t.db
    .insert(spaces)
    .values([
      { organizationId: "org_a", name: "Cloud", mode: "cloud", adapterId: "fp-cloud", rootRef: "" },
      { organizationId: "org_b", name: "Cloud", mode: "cloud", adapterId: "fp-cloud", rootRef: "" },
    ])
    .returning();
  spaceA = a!.id;
  spaceB = b!.id;
});

afterAll(async () => {
  await t?.drop();
});

function setup(store: EngineStore, adapter: MemoryAdapter) {
  return createEngine({ store, adapterFor: async () => adapter });
}

describe("Postgres EngineStore", () => {
  it("executes a plan: plan_steps statuses, file rows and one audit batch", async () => {
    const adapter = new MemoryAdapter({ "Inbox/a.pdf": "aaa", "Inbox/b.pdf": "bbb" });
    const ids = await index(adapter, "org_a", spaceA);
    const store = createPgEngineStore(t.db, "org_a");
    const engine = setup(store, adapter);

    const planId = await engine.createPlan({
      spaceId: spaceA,
      source: "agent",
      actor: "agent:user_1",
      summary: "File invoices",
      steps: [
        { fileId: ids.get("Inbox/a.pdf")!, action: "move", to: "Invoices/a.pdf" },
        { fileId: ids.get("Inbox/b.pdf")!, action: "tag", to: "invoice" },
        { fileId: ids.get("Inbox/b.pdf")!, action: "category", to: "Invoices" },
      ],
    });
    await engine.approve(planId, owner);
    const res = await engine.execute(planId);
    expect(res).toMatchObject({ status: "executed", done: 3 });

    const steps = await t.db.select().from(planSteps).where(eq(planSteps.planId, String(planId)));
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    const [a] = await t.db.select().from(files).where(eq(files.id, ids.get("Inbox/a.pdf")!));
    expect(a).toMatchObject({ path: "Invoices/a.pdf", name: "a.pdf", status: "organized" });
    const [b] = await t.db.select().from(files).where(eq(files.id, ids.get("Inbox/b.pdf")!));
    expect(b).toMatchObject({ tags: ["invoice"], category: "Invoices", categorySource: "user" });

    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.planId, String(planId)));
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.batchId)).size).toBe(1);
    expect(events.every((e) => e.organizationId === "org_a" && e.spaceId === spaceA && e.actor === "agent:user_1")).toBe(true);
    expect(events.find((e) => e.action === "move")!.after).toMatchObject({ value: "Invoices/a.pdf", version: "v1" });
  });

  it("undo writes new events with undoes_event_id and the view shows undone_by", async () => {
    const adapter = new MemoryAdapter({ "x/c.txt": "c" });
    const ids = await index(adapter, "org_a", spaceA);
    const store = createPgEngineStore(t.db, "org_a");
    const engine = setup(store, adapter);
    const res = await engine.run({ spaceId: spaceA, summary: "Move", steps: [{ fileId: ids.get("x/c.txt")!, action: "move", to: "y/c.txt" }] }, owner);
    const undo = await engine.undo({ batchId: res.batchId }, owner, { spaceId: spaceA });
    expect(undo.done).toBe(1);
    expect(adapter.paths()).toContain("x/c.txt");

    const [orig] = await t.db.select().from(auditEvents).where(eq(auditEvents.batchId, res.batchId));
    const view = await t.db.execute<{ undone_by: string | null; undone_by_event_id: string | null; space_id: string }>(
      sql`select undone_by, undone_by_event_id, space_id from audit_events_with_undo where id = ${orig!.id}`,
    );
    expect(view[0]).toMatchObject({ undone_by: "user:user_1", space_id: spaceA });
    const [undoRow] = await t.db.select().from(auditEvents).where(eq(auditEvents.id, view[0]!.undone_by_event_id!));
    expect(undoRow).toMatchObject({ action: "undo", undoesEventId: orig!.id });
    // Undoing again finds nothing left.
    await expect(engine.undo({ batchId: res.batchId }, owner)).rejects.toThrow(/nothing left/);
  });

  it("keeps trash history: trashed_by, purge_after, restored_at", async () => {
    const adapter = new MemoryAdapter({ "old.jpg": "o" });
    const ids = await index(adapter, "org_a", spaceA);
    const engine = setup(createPgEngineStore(t.db, "org_a"), adapter);
    await engine.run({ spaceId: spaceA, summary: "Trash", steps: [{ fileId: ids.get("old.jpg")!, action: "trash" }] }, owner);
    let [item] = await t.db.select().from(trashItems).where(eq(trashItems.fileId, ids.get("old.jpg")!));
    expect(item).toMatchObject({ originalPath: "old.jpg", trashedBy: "user:user_1", restoredAt: null });
    expect(item!.purgeAfter.getTime() - item!.trashedAt.getTime()).toBe(30 * 86_400_000);

    await engine.run({ spaceId: spaceA, summary: "Restore", steps: [{ fileId: ids.get("old.jpg")!, action: "restore" }] }, owner);
    [item] = await t.db.select().from(trashItems).where(eq(trashItems.fileId, ids.get("old.jpg")!));
    expect(item!.restoredAt).not.toBeNull();
    expect(adapter.paths()).toContain("old.jpg");
  });

  it("rolls back the index write and audit event together when a commit fails", async () => {
    const adapter = new MemoryAdapter({ "r.txt": "r" });
    const ids = await index(adapter, "org_a", spaceA);
    const store = createPgEngineStore(t.db, "org_a");
    const before = (await t.db.select().from(auditEvents)).length;
    await expect(
      store.transaction(async () => {
        await store.updateFile(ids.get("r.txt")!, { caption: "half written" });
        await store.appendAudit({ at: Date.now(), spaceId: spaceA, actor: "user:user_1", action: "caption", fileIds: [ids.get("r.txt")!], batchId: crypto.randomUUID() });
        throw new Error("crash");
      }),
    ).rejects.toThrow("crash");
    const [row] = await t.db.select().from(files).where(eq(files.id, ids.get("r.txt")!));
    expect(row!.caption).toBeNull();
    expect((await t.db.select().from(auditEvents)).length).toBe(before);
  });

  it("is scoped to one organization: another org can't see or run the plan or its files", async () => {
    const adapter = new MemoryAdapter({ "secret.pdf": "s" });
    const ids = await index(adapter, "org_a", spaceA);
    const engineA = setup(createPgEngineStore(t.db, "org_a"), adapter);
    const engineB = setup(createPgEngineStore(t.db, "org_b"), adapter);
    const planId = await engineA.createPlan({ spaceId: spaceA, source: "agent", actor: "agent:user_1", summary: "x", steps: [{ fileId: ids.get("secret.pdf")!, action: "tag", to: "t" }] });

    await expect(engineB.approve(planId, owner)).rejects.toThrow(/not found/);
    await expect(engineB.execute(planId)).rejects.toThrow(/not found/);
    // A plan in org B that names org A's file can't touch it.
    const sneaky = await engineB.run({ spaceId: spaceB, summary: "x", steps: [{ fileId: ids.get("secret.pdf")!, action: "caption", to: "pwned" }] }, owner);
    expect(sneaky.done).toBe(0);
    const [row] = await t.db.select().from(files).where(eq(files.id, ids.get("secret.pdf")!));
    expect(row!.caption).toBeNull();
    expect(await createPgEngineStore(t.db, "org_b").findAudit({ spaceId: spaceA })).toEqual([]);
  });
});
