import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, type NewFileRecord } from "../db";
import { registerRootHandle } from "../file-access-cache";
import { asDir, FakeDirHandle } from "@/test/fake-fs";
import { createPlan, executePlan, runUserAction, undoBatch, undoEntry } from "./engine";

let root: FakeDirHandle;
let rootId: number;

async function addFile(path: string, extra: Partial<NewFileRecord> = {}) {
  await root.put(path, `content of ${path}`);
  const name = path.split("/").pop()!;
  return db.files.add({ rootId, path, name, ext: name.split(".").pop()!, kind: "document", size: 10, mtime: 0, status: "indexed", flags: [], tags: [], ...extra });
}

beforeEach(async () => {
  await Promise.all([db.files.clear(), db.roots.clear(), db.audit.clear(), db.plans.clear(), db.rules.clear()]);
  root = new FakeDirHandle("root");
  rootId = await db.roots.add({ name: "root", handle: {} as FileSystemDirectoryHandle, addedAt: 0 });
  registerRootHandle(rootId, asDir(root));
});

describe("action engine", () => {
  it("executes a plan, updates the index and writes one audit entry per step in one batch", async () => {
    const a = await addFile("Downloads/a.pdf");
    const b = await addFile("Downloads/b.pdf");
    const planId = await createPlan({
      rootId,
      source: "agent",
      actor: "agent",
      summary: "File invoices",
      steps: [
        { fileId: a, action: "move", from: "Downloads/a.pdf", to: "Invoices/a.pdf" },
        { fileId: b, action: "tag", to: "invoice" },
      ],
    });
    expect(root.paths()).toContain("Downloads/a.pdf"); // nothing happens before approval

    const res = await executePlan(planId);
    expect(res).toMatchObject({ done: 2, failed: 0, summary: "Moved 1 file · Tagged 1 file" });
    expect(root.paths()).toContain("Invoices/a.pdf");
    expect((await db.files.get(a))!.path).toBe("Invoices/a.pdf");
    expect((await db.files.get(b))!.tags).toEqual(["invoice"]);
    const audit = await db.audit.toArray();
    expect(audit).toHaveLength(2);
    expect(new Set(audit.map((e) => e.batchId)).size).toBe(1);
    expect(audit.every((e) => e.actor === "agent" && e.planId === planId)).toBe(true);
    expect((await db.plans.get(planId))!.status).toBe("executed");
  });

  it("undoes a whole batch in reverse order and logs the undo", async () => {
    const a = await addFile("x/a.txt");
    const res = await runUserAction(rootId, "Organize", [
      { fileId: a, action: "move", to: "y/a.txt" },
      { fileId: a, action: "rename", to: "y/renamed.txt" },
      { fileId: a, action: "caption", to: "A caption" },
    ]);
    expect((await db.files.get(a))!.path).toBe("y/renamed.txt");

    const undo = await undoBatch(res.batchId);
    expect(undo).toEqual({ undone: 3, failed: 0, errors: [] });
    const file = (await db.files.get(a))!;
    expect(file.path).toBe("x/a.txt");
    expect(file.name).toBe("a.txt");
    expect(file.caption).toBe("");
    expect(root.paths()).toEqual(["x/a.txt"]);
    const entries = await db.audit.toArray();
    expect(entries.filter((e) => e.action === "undo")).toHaveLength(3);
    expect(entries.filter((e) => e.batchId === res.batchId).every((e) => e.undone)).toBe(true);
    // Undoing again is a no-op.
    expect((await undoBatch(res.batchId)).undone).toBe(0);
  });

  it("trashes into .folderpilot-trash and restores to the original path", async () => {
    const a = await addFile("Photos/blurry.jpg", { flags: ["blurry", "suggested_delete"] });
    const res = await runUserAction(rootId, "Trash", [{ fileId: a, action: "trash" }]);
    let file = (await db.files.get(a))!;
    expect(file.status).toBe("trashed");
    expect(file.path).toBe(".folderpilot-trash/Photos/blurry.jpg");
    expect(file.trashedFrom).toBe("Photos/blurry.jpg");
    expect(file.flags).toEqual(["blurry"]);
    expect(root.paths()).toEqual([".folderpilot-trash/Photos/blurry.jpg"]);

    await runUserAction(rootId, "Restore", [{ fileId: a, action: "restore" }]);
    file = (await db.files.get(a))!;
    expect(file.path).toBe("Photos/blurry.jpg");
    expect(file.status).toBe("indexed");
    expect(root.paths()).toContain("Photos/blurry.jpg");
    expect(res.summary).toBe("Moved to Trash: 1 file");
  });

  it("undoes a single entry and refuses to undo a move that was superseded", async () => {
    const a = await addFile("a.txt");
    const first = await runUserAction(rootId, "m1", [{ fileId: a, action: "move", to: "one/a.txt" }]);
    await runUserAction(rootId, "m2", [{ fileId: a, action: "move", to: "two/a.txt" }]);
    const firstEntry = (await db.audit.where("batchId").equals(first.batchId).first())!;
    const res = await undoEntry(firstEntry.id);
    expect(res.undone).toBe(0);
    expect(res.errors[0]).toMatch(/has moved since/);
    expect((await db.files.get(a))!.path).toBe("two/a.txt");
  });

  it("creates rules only through an approved plan, and undo removes them", async () => {
    const planId = await createPlan({
      rootId,
      source: "agent",
      actor: "agent",
      summary: "New rule",
      steps: [{ action: "rule_create", to: JSON.stringify({ type: "structured", name: "Screens", enabled: true, priority: 1, match: "all", conditions: [], actions: [], createdBy: "agent" }) }],
    });
    expect(await db.rules.count()).toBe(0);
    const res = await executePlan(planId);
    expect(await db.rules.count()).toBe(1);
    await undoBatch(res.batchId);
    expect(await db.rules.count()).toBe(0);
  });

  it("restores category, status and flags on undo", async () => {
    const a = await addFile("c.pdf", { status: "needs_review", category: "Misc" });
    const res = await runUserAction(rootId, "Fix", [
      { fileId: a, action: "category", to: "Invoices" },
      { fileId: a, action: "flag", to: "suggested_delete", after: "old copy" },
    ]);
    let f = (await db.files.get(a))!;
    expect(f).toMatchObject({ category: "Invoices", status: "analyzed", flags: ["suggested_delete"], flagReason: "old copy" });
    await undoBatch(res.batchId);
    f = (await db.files.get(a))!;
    expect(f).toMatchObject({ category: "Misc", status: "needs_review", flags: [] });
  });
});
