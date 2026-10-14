import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, type NewFileRecord } from "../db";
import { registerMemoryFiles, registerRootHandle } from "../file-access-cache";
import { asDir, FakeDirHandle } from "@/test/fake-fs";
import { acceptReview } from "./user-actions";

// Toasts need a browser window; the engine result is what we test here.
vi.mock("@/stores/toasts", () => ({ toast: () => 0 }));
import { createPlan, executePlan, resolveConflict, runUserAction, undoAgentSince, undoBatch, undoEntry } from "./engine";

let root: FakeDirHandle;
let rootId: number;

/** Put a file on the fake disk and index it the way the indexer does (size + lastModified). */
async function addFile(path: string, extra: Partial<NewFileRecord> = {}) {
  const handle = await root.put(path, `content of ${path}`);
  const disk = await handle.getFile();
  const name = path.split("/").pop()!;
  return db.files.add({ rootId, path, name, ext: name.split(".").pop()!, kind: "document", size: disk.size, mtime: disk.lastModified, status: "indexed", flags: [], tags: [], ...extra });
}

beforeEach(async () => {
  await Promise.all([db.files.clear(), db.roots.clear(), db.audit.clear(), db.plans.clear(), db.rules.clear(), db.trash.clear()]);
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
      actor: "agent:local",
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
    expect(audit.every((e) => e.actor === "agent:local" && e.planId === planId)).toBe(true);
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
    // Append-only: originals are untouched; each undo event points at one of them.
    const originals = entries.filter((e) => e.batchId === res.batchId);
    expect(originals.every((e) => e.undone === undefined)).toBe(true);
    expect(new Set(entries.filter((e) => e.action === "undo").map((e) => e.undoesEventId))).toEqual(new Set(originals.map((e) => e.id)));
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
    expect(await db.trash.count()).toBe(0); // restored → no longer in the trash bookkeeping
  });

  it("undoes a single entry and refuses to undo a move that was superseded", async () => {
    const a = await addFile("a.txt");
    const first = await runUserAction(rootId, "m1", [{ fileId: a, action: "move", to: "one/a.txt" }]);
    await runUserAction(rootId, "m2", [{ fileId: a, action: "move", to: "two/a.txt" }]);
    const firstEntry = (await db.audit.where("batchId").equals(first.batchId).first())!;
    const res = await undoEntry(firstEntry.id);
    expect(res.undone).toBe(0);
    expect(res.errors[0]).toMatch(/changed again after this action/);
    expect((await db.files.get(a))!.path).toBe("two/a.txt");
  });

  it("creates rules only through an approved plan, and undo removes them", async () => {
    const planId = await createPlan({
      rootId,
      source: "agent",
      actor: "agent:local",
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

  it("marks a step conflicted when the file was edited after the plan was made, then applies it on request", async () => {
    const a = await addFile("Inbox/report.docx");
    const planId = await createPlan({ rootId, source: "agent", actor: "agent:local", summary: "File it", steps: [{ fileId: a, action: "move", to: "Reports/report.docx" }] });
    await root.put("Inbox/report.docx", "edited in Word meanwhile");
    const res = await executePlan(planId);
    expect(res).toMatchObject({ done: 0, conflicted: 1 });
    expect(root.paths()).toContain("Inbox/report.docx");
    const plan = (await db.plans.get(planId))!;
    expect(plan.status).toBe("partially_failed");
    expect(plan.steps[0]).toMatchObject({ status: "conflicted" });

    const retried = await resolveConflict(planId, 0, "retry");
    expect(retried).toMatchObject({ done: 1 });
    expect(root.paths()).toContain("Reports/report.docx");
    expect(await root.read("Reports/report.docx")).toBe("edited in Word meanwhile");
    expect((await db.plans.get(planId))!.status).toBe("executed");
  });

  it("keeps trash bookkeeping with a retention date", async () => {
    const a = await addFile("old.txt");
    await runUserAction(rootId, "Trash", [{ fileId: a, action: "trash" }]);
    const t = (await db.trash.get(a))!;
    expect(t).toMatchObject({ rootId, originalPath: "old.txt", trashedBy: "user:local" });
    expect(t.purgeAfter - t.trashedAt).toBe(30 * 86_400_000);
  });

  it("refuses to let the agent trash, even through createPlan", async () => {
    const a = await addFile("x.txt");
    await expect(createPlan({ rootId, source: "agent", actor: "agent:local", summary: "x", steps: [{ fileId: a, action: "trash" }] })).rejects.toThrow(/Only a person/);
  });

  it("undoes everything the agent did since a time, but not the person's own changes", async () => {
    const a = await addFile("a.txt");
    const b = await addFile("b.txt");
    await runUserAction(rootId, "mine", [{ fileId: b, action: "tag", to: "mine" }]);
    const since = Date.now();
    const planId = await createPlan({ rootId, source: "agent", actor: "agent:local", summary: "agent", steps: [{ fileId: a, action: "move", to: "Agent/a.txt" }] });
    await executePlan(planId);
    expect(await undoAgentSince(rootId, since)).toMatchObject({ undone: 1, failed: 0 });
    expect(root.paths()).toContain("a.txt");
    expect((await db.files.get(b))!.tags).toEqual(["mine"]);
  });

  it("refuses disk changes in read-only folders with a clear message", async () => {
    const ro = await db.roots.add({ name: "ro", readOnly: true, addedAt: 0 });
    registerMemoryFiles(ro, new Map([["a.txt", new File(["x"], "a.txt", { lastModified: 5 })]]));
    const id = await db.files.add({ rootId: ro, path: "a.txt", name: "a.txt", ext: "txt", kind: "document", size: 1, mtime: 5, status: "indexed", flags: [], tags: [] });
    const res = await runUserAction(ro, "x", [
      { fileId: id, action: "rename", to: "b.txt" },
      { fileId: id, action: "caption", to: "still works" },
    ]);
    expect(res).toMatchObject({ done: 1, failed: 1 });
    expect(res.errors[0]).toMatch(/read-only/);
    expect((await db.files.get(id))!.caption).toBe("still works");
  });

  it("accepting an AI suggestion goes through the engine: status changes, it's audited, and undo puts it back", async () => {
    const a = await addFile("scan.pdf", { status: "needs_review", category: "Scans", confidence: 0.4 });
    await acceptReview([(await db.files.get(a))!]);
    expect((await db.files.get(a))!).toMatchObject({ status: "analyzed", category: "Scans" });
    const [event] = (await db.audit.toArray()).filter((e) => e.action === "category");
    expect(event).toMatchObject({ actor: "user:local", fileIds: [a] });
    await undoBatch(event!.batchId);
    expect((await db.files.get(a))!.status).toBe("needs_review");
  });
});
