import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NewRule } from "@folderpilot/core";
import { db, type NewFileRecord } from "../db";
import { registerRootHandle } from "../file-access-cache";
import { asDir, FakeDirHandle } from "@/test/fake-fs";

vi.mock("@/stores/toasts", () => ({ toast: () => 0 }));
import { runDueScheduledRules, runRulesNow, runRulesOnNewFiles } from "./device-runner";
import { archiveRule } from "./store";
import { undoBatch } from "../actions/engine";

let root: FakeDirHandle;
let rootId: number;

async function addFile(path: string, extra: Partial<NewFileRecord> = {}) {
  const handle = await root.put(path, `content of ${path}`);
  const disk = await handle.getFile();
  const name = path.split("/").pop()!;
  return db.files.add({ rootId, path, name, ext: name.split(".").pop()!, kind: "document", size: disk.size, mtime: disk.lastModified, status: "analyzed", flags: [], tags: [], analyzedLocally: true, ...extra });
}

const rule = (name: string, extra: Partial<NewRule>): NewRule => ({
  type: "structured",
  name,
  enabled: true,
  priority: 1,
  match: "all",
  conditions: [{ field: "ext", op: "is", value: "txt" }],
  actions: [{ type: "tag", value: "text" }],
  createdBy: "user",
  createdAt: 0,
  ...extra,
});

beforeEach(async () => {
  await Promise.all([db.files.clear(), db.roots.clear(), db.audit.clear(), db.plans.clear(), db.rules.clear(), db.trash.clear()]);
  root = new FakeDirHandle("root");
  rootId = await db.roots.add({ name: "root", handle: {} as FileSystemDirectoryHandle, addedAt: 0 });
  registerRootHandle(rootId, asDir(root));
});

describe("device rules", () => {
  it("after analysis: auto rules apply (audited as the rule, undoable), suggest rules wait, nothing runs twice", async () => {
    const autoId = await db.rules.add(rule("Text", { mode: "auto" }));
    const suggestId = await db.rules.add(rule("Notes", { priority: 2, mode: "suggest", conditions: [{ field: "ext", op: "is", value: "md" }], actions: [{ type: "move", value: "Notes" }] }));
    const txt = await addFile("a.txt");
    const md = await addFile("readme.md");

    const outcomes = await runRulesOnNewFiles(rootId);
    expect(outcomes.map((o) => [o.ruleId, o.mode, o.files])).toEqual([
      [autoId, "auto", 1],
      [suggestId, "suggest", 1],
    ]);
    expect((await db.files.get(txt))!.tags).toEqual(["text"]);
    const events = await db.audit.toArray();
    expect(events.map((e) => e.actor)).toEqual([`rule:${autoId}`]);
    const pending = (await db.plans.toArray()).filter((p) => p.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ actor: `rule:${suggestId}`, source: "rule" });
    expect(root.paths()).toContain("readme.md"); // the suggestion hasn't touched the disk
    expect((await db.files.get(md))!.path).toBe("readme.md");

    expect(await runRulesOnNewFiles(rootId)).toEqual([]);
    // "Run" again: the auto change is already there and the suggestion is still waiting — no duplicates.
    expect(await runRulesNow(rootId)).toEqual([]);

    await undoBatch(outcomes[0]!.result!.batchId);
    expect((await db.files.get(txt))!.tags).toEqual([]);
  });

  it("rules scoped to another folder, paused or archived rules don't run", async () => {
    const otherRoot = await db.roots.add({ name: "other", addedAt: 0 });
    await db.rules.add(rule("Elsewhere", { mode: "auto", scopeSpaceId: otherRoot }));
    await db.rules.add(rule("Paused", { mode: "auto", enabled: false }));
    const archivedId = await db.rules.add(rule("Archived", { mode: "auto" }));
    await archiveRule((await db.rules.get(archivedId))!, rootId);
    await addFile("a.txt");
    expect(await runRulesOnNewFiles(rootId)).toEqual([]);
    expect((await db.rules.get(archivedId))!).toMatchObject({ archived: true, enabled: false });
  });

  it("a suggest rule can't execute by itself", async () => {
    await db.rules.add(rule("Suggest", { mode: "suggest" }));
    await addFile("a.txt");
    const [o] = await runRulesOnNewFiles(rootId);
    expect(o!.result).toBeUndefined();
    expect((await db.plans.get(o!.planId))!.status).toBe("pending");
  });

  it("scheduled rules run when due and record lastRunAt", async () => {
    const id = await db.rules.add(rule("Daily", { mode: "auto", schedule: "daily" }));
    await addFile("a.txt");
    const now = 1_800_000_000_000;
    expect(await runDueScheduledRules(now)).toHaveLength(1);
    expect((await db.rules.get(id))!.lastRunAt).toBe(now);
    expect(await runDueScheduledRules(now + 3_600_000)).toEqual([]);
  });
});
