import "fake-indexeddb/auto";
import Dexie from "dexie";
import { expect, it } from "vitest";

it("upgrades a v2 database: step statuses, legacy undo flags kept, trash bookkeeping, old undo proposals cancelled", async () => {
  const name = `fp-migration-${Date.now()}`;
  const v2 = new Dexie(name);
  v2.version(2).stores({
    roots: "++id, name, addedAt",
    files: "++id, rootId, &[rootId+path], name, ext, kind, status, category, *flags, *tags, sha256, [rootId+status]",
    rules: "++id, priority, enabled, type",
    plans: "++id, rootId, status, createdAt, batchId",
    audit: "++id, at, rootId, batchId, planId, actor",
    settings: "key",
    embeddings: "fileId, rootId",
  });
  await v2.open();
  await v2.table("files").add({ rootId: 1, path: ".folderpilot-trash/x.jpg", name: "x.jpg", ext: "jpg", kind: "image", size: 1, mtime: 5, status: "trashed", trashedFrom: "Photos/x.jpg", flags: [], tags: [] });
  await v2.table("plans").bulkAdd([
    { rootId: 1, source: "user", actor: "user", summary: "done", steps: [{ action: "tag", fileId: 1, to: "a" }], status: "executed", createdAt: 1 },
    { rootId: 1, source: "agent", actor: "agent", summary: "undo", steps: [{ action: "move", fileId: 1 }], status: "pending", createdAt: 2, undoBatchId: "b1" },
    { rootId: 1, source: "agent", actor: "agent", summary: "todo", steps: [{ action: "tag", fileId: 1, to: "b" }], status: "pending", createdAt: 3 },
  ]);
  await v2.table("audit").add({ at: 1, actor: "user", action: "tag", fileIds: [1], batchId: "b1", undone: true, rootId: 1 });
  v2.close();

  const { FolderPilotDBForTests } = await import("./db");
  const db = new FolderPilotDBForTests(name);
  await db.open();
  const plans = await db.plans.toArray();
  expect(plans[0]!.steps[0]).toMatchObject({ seq: 0, status: "done" });
  expect(plans[1]).toMatchObject({ status: "cancelled" });
  expect(plans[1]).not.toHaveProperty("undoBatchId");
  expect(plans[2]!.steps[0]).toMatchObject({ seq: 0, status: "pending" });
  expect((await db.audit.toArray())[0]).toMatchObject({ undone: true });
  expect(await db.trash.get(1)).toMatchObject({ rootId: 1, originalPath: "Photos/x.jpg" });
  db.close();
});
