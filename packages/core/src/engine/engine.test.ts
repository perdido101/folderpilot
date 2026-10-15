import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { MemoryAdapter, MemoryStore } from "../testing/memory";
import type { StorageAdapter } from "../storage/types";
import type { StepAction } from "../types";
import { canAutoRun, createEngine, EngineError, type Approver } from "./engine";

const owner: Approver = { userId: "u1", role: "owner" };
const editor: Approver = { userId: "u2", role: "editor" };
const viewer: Approver = { userId: "u3", role: "viewer" };

let adapter: MemoryAdapter;
let store: MemoryStore;
let ids: Map<string, string | number>;
let engine: ReturnType<typeof createEngine>;
let clock: number;

const id = (path: string) => ids.get(path)!;

beforeEach(async () => {
  adapter = new MemoryAdapter({ "Downloads/a.pdf": "aaa", "Downloads/b.pdf": "bbbb", "Downloads/c.jpg": "ccccc", "Inbox/note.txt": "hello" });
  store = new MemoryStore();
  ids = await store.indexFrom(adapter, 1);
  clock = 1_000;
  let batch = 0;
  engine = createEngine({ store, adapterFor: async () => adapter, now: () => ++clock, newBatchId: () => `batch-${++batch}` });
});

describe("plans", () => {
  it("changes nothing until approved, then executes every step and audits one batch", async () => {
    const planId = await engine.createPlan({
      spaceId: 1,
      source: "agent",
      actor: "agent:u1",
      summary: "File invoices",
      steps: [
        { fileId: id("Downloads/a.pdf"), action: "move", to: "Invoices/2025/a.pdf" },
        { fileId: id("Downloads/b.pdf"), action: "tag", to: "Invoice" },
      ],
    });
    await expect(engine.execute(planId)).rejects.toThrow(/approved/);
    expect(adapter.writes).toEqual([]);

    await engine.approve(planId, editor);
    const res = await engine.execute(planId);
    expect(res).toMatchObject({ status: "executed", done: 2, failed: 0, conflicted: 0, doneActions: ["move", "tag"] });
    expect(adapter.paths()).toContain("Invoices/2025/a.pdf");
    expect(store.file(id("Downloads/a.pdf"))).toMatchObject({ path: "Invoices/2025/a.pdf", name: "a.pdf", status: "organized" });
    expect(store.file(id("Downloads/b.pdf")).tags).toEqual(["invoice"]);

    const plan = (await store.getPlan(planId))!;
    expect(plan).toMatchObject({ status: "executed", approvedBy: "u2", batchId: "batch-1" });
    expect(plan.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(store.state.audit).toHaveLength(2);
    expect(store.state.audit.every((e) => e.batchId === "batch-1" && e.actor === "agent:u1" && e.planId === planId)).toBe(true);
    expect(store.state.audit[0]).toMatchObject({ action: "move", from: "Downloads/a.pdf", to: "Invoices/2025/a.pdf", fromVersion: "v1", toVersion: "v1" });
  });

  it("records the version each file step was planned against", async () => {
    const planId = await engine.createPlan({ spaceId: 1, source: "user", actor: "user:u1", summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "rename", to: "Downloads/A.pdf" }] });
    expect((await store.getPlan(planId))!.steps[0]).toMatchObject({ seq: 0, status: "pending", expectVersion: "v1" });
  });

  it("lets a viewer propose but not approve", async () => {
    const planId = await engine.createPlan({ spaceId: 1, source: "agent", actor: "agent:u3", summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "tag", to: "t" }] });
    await expect(engine.approve(planId, viewer)).rejects.toThrow(/can't|not approve/);
    expect((await store.getPlan(planId))!.status).toBe("pending");
  });

  it("edit keeps only the chosen steps; cancel stops a plan for good", async () => {
    const planId = await engine.createPlan({
      spaceId: 1,
      source: "agent",
      actor: "agent:u1",
      summary: "x",
      steps: [
        { fileId: id("Downloads/a.pdf"), action: "tag", to: "one" },
        { fileId: id("Downloads/b.pdf"), action: "tag", to: "two" },
      ],
    });
    await engine.keepSteps(planId, [1]);
    expect((await store.getPlan(planId))!.steps.map((s) => s.seq)).toEqual([1]);
    await engine.cancel(planId);
    await expect(engine.approve(planId, owner)).rejects.toThrow(/cancelled/);
    await expect(engine.execute(planId)).rejects.toThrow(/cancelled/);
  });

  it("rejects unknown actions and file steps without a file", async () => {
    await expect(engine.createPlan({ spaceId: 1, source: "user", actor: "user:u1", summary: "x", steps: [{ action: "delete" as StepAction, fileId: 1 }] })).rejects.toThrow(/Unknown/);
    await expect(engine.createPlan({ spaceId: 1, source: "user", actor: "user:u1", summary: "x", steps: [{ action: "move", to: "x" }] })).rejects.toThrow(/needs a file/);
  });

  it("keeps going after a failed step and reports partially_failed", async () => {
    adapter.failNextWrite = new Error("provider hiccup");
    const res = await engine.run(
      {
        spaceId: 1,
        summary: "Two moves",
        steps: [
          { fileId: id("Downloads/a.pdf"), action: "move", to: "X/a.pdf" },
          { fileId: id("Downloads/b.pdf"), action: "move", to: "X/b.pdf" },
        ],
      },
      owner,
    );
    expect(res).toMatchObject({ status: "partially_failed", done: 1, failed: 1, errors: ["provider hiccup"] });
    expect(adapter.paths()).toContain("X/b.pdf");
    expect(adapter.paths()).toContain("Downloads/a.pdf");
  });

  it("creates folders (and skips ones that exist)", async () => {
    const res = await engine.run(
      {
        spaceId: 1,
        summary: "Folders",
        steps: [
          { action: "createFolder", to: "Clients/Alpha" },
          { action: "createFolder", to: "Downloads" },
        ],
      },
      owner,
    );
    expect(res).toMatchObject({ done: 1, skipped: 1 });
    expect(await adapter.resolve("Clients/Alpha")).toMatchObject({ isFolder: true });
  });

  it("never overwrites: a taken name gets a suffix", async () => {
    adapter.put("Archive/a.pdf", "other");
    await engine.run({ spaceId: 1, summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "move", to: "Archive/a.pdf" }] }, owner);
    expect(adapter.paths()).toEqual(expect.arrayContaining(["Archive/a.pdf", "Archive/a (2).pdf"]));
    expect(store.file(id("Downloads/a.pdf")).path).toBe("Archive/a (2).pdf");
  });

  it("emits progress for every step", async () => {
    const seen: number[] = [];
    await engine.run(
      { spaceId: 1, summary: "x", steps: ["Downloads/a.pdf", "Downloads/b.pdf", "Downloads/c.jpg"].map((p) => ({ fileId: id(p), action: "tag" as const, to: "t" })) },
      owner,
      { onProgress: (e) => seen.push(e.done / e.total) },
    );
    expect(seen).toEqual([1 / 3, 2 / 3, 1]);
  });

  it("fails cleanly on read-only folders but still allows index-only changes", async () => {
    const ro = new MemoryAdapter({ "a.txt": "x" }, { readOnly: true });
    const roStore = new MemoryStore();
    const roIds = await roStore.indexFrom(ro);
    const roEngine = createEngine({ store: roStore, adapterFor: async () => ro });
    const res = await roEngine.run(
      {
        spaceId: 1,
        summary: "x",
        steps: [
          { fileId: roIds.get("a.txt")!, action: "rename", to: "b.txt" },
          { fileId: roIds.get("a.txt")!, action: "caption", to: "A note" },
        ],
      },
      owner,
    );
    expect(res).toMatchObject({ done: 1, failed: 1 });
    expect(res.errors[0]).toMatch(/read-only/);
    expect(ro.paths()).toEqual(["a.txt"]);
    expect(roStore.file(roIds.get("a.txt")!).caption).toBe("A note");
  });
});

describe("only people can trash (no delete exists)", () => {
  for (const source of ["agent", "rule", "mcp"] as const) {
    it(`rejects trash and restore in ${source} plans`, async () => {
      for (const action of ["trash", "restore"] as const) {
        await expect(engine.createPlan({ spaceId: 1, source, actor: `${source}:x`, summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action }] })).rejects.toThrow(/Only a person/);
      }
    });
  }

  it("also refuses at execute time if a stored plan was tampered with", async () => {
    const planId = await engine.createPlan({ spaceId: 1, source: "agent", actor: "agent:u1", summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "flag", to: "suggested_delete" }] });
    await engine.approve(planId, owner);
    const plan = store.state.plans.get(String(planId))!;
    plan.steps[0]!.action = "trash";
    await expect(engine.execute(planId)).rejects.toThrow(/Only a person/);
    expect(adapter.trashed()).toEqual([]);
  });

  it("a user plan can't claim to come from the user while the actor is the agent", async () => {
    await expect(engine.createPlan({ spaceId: 1, source: "user", actor: "agent:u1", summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "trash" }] })).rejects.toThrow(/Only a person/);
  });

  it("agents can flag for deletion; a person trashes; trash is recoverable with retention", async () => {
    const flagPlan = await engine.createPlan({
      spaceId: 1,
      source: "agent",
      actor: "agent:u1",
      summary: "Flag blurry",
      steps: [{ fileId: id("Downloads/c.jpg"), action: "flag", to: "suggested_delete", after: "blurry" }],
    });
    await engine.approve(flagPlan, owner);
    await engine.execute(flagPlan);
    expect(store.file(id("Downloads/c.jpg")).flags).toEqual(["suggested_delete"]);
    expect(adapter.trashed()).toEqual([]);

    await engine.run({ spaceId: 1, summary: "Trash", steps: [{ fileId: id("Downloads/c.jpg"), action: "trash" }] }, owner);
    expect(adapter.paths()).not.toContain("Downloads/c.jpg");
    expect(adapter.trashed()).toHaveLength(1);
    expect(store.file(id("Downloads/c.jpg"))).toMatchObject({ status: "trashed", trashedFrom: "Downloads/c.jpg", flags: [] });
    const trash = (await store.getTrash(id("Downloads/c.jpg")))!;
    expect(trash).toMatchObject({ originalPath: "Downloads/c.jpg", trashedBy: "user:u1" });
    expect(trash.purgeAfter - trash.trashedAt).toBe(30 * 86_400_000);

    await engine.run({ spaceId: 1, summary: "Restore", steps: [{ fileId: id("Downloads/c.jpg"), action: "restore" }] }, owner);
    expect(adapter.paths()).toContain("Downloads/c.jpg");
    expect(await store.getTrash(id("Downloads/c.jpg"))).toBeUndefined();
    expect(store.file(id("Downloads/c.jpg"))).toMatchObject({ status: "indexed", path: "Downloads/c.jpg" });
  });

  it("restores next to the original if the name was taken meanwhile", async () => {
    await engine.run({ spaceId: 1, summary: "Trash", steps: [{ fileId: id("Downloads/a.pdf"), action: "trash" }] }, owner);
    adapter.put("Downloads/a.pdf", "new one");
    await engine.run({ spaceId: 1, summary: "Restore", steps: [{ fileId: id("Downloads/a.pdf"), action: "restore" }] }, owner);
    expect(store.file(id("Downloads/a.pdf")).path).toBe("Downloads/a (2).pdf");
  });

  it("has no delete anywhere in the types", () => {
    expectTypeOf<Extract<StepAction, "delete">>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof StorageAdapter, "delete" | "remove" | "purge">>().toEqualTypeOf<never>();
    expect(Object.keys(engine)).not.toContain("delete");
  });
});

describe("conflicts", () => {
  it("marks a step conflicted when the file changed since planning, and touches nothing", async () => {
    const planId = await engine.createPlan({ spaceId: 1, source: "agent", actor: "agent:u1", summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "move", to: "X/a.pdf" }] });
    adapter.edit("Downloads/a.pdf", "edited by someone");
    await engine.approve(planId, owner);
    const res = await engine.execute(planId);
    expect(res).toMatchObject({ status: "partially_failed", conflicted: 1, done: 0 });
    expect(res.errors[0]).toMatch(/changed after this plan was made/);
    expect(adapter.writes).toEqual([]);
    expect((await store.getPlan(planId))!.steps[0]!.status).toBe("conflicted");
  });

  it("marks a step conflicted when the file disappeared", async () => {
    const planId = await engine.createPlan({ spaceId: 1, source: "user", actor: "user:u1", summary: "x", steps: [{ fileId: id("Inbox/note.txt"), action: "trash" }] });
    adapter.nodes.delete(store.file(id("Inbox/note.txt")).ref.id);
    await engine.approve(planId, owner);
    expect(await engine.execute(planId)).toMatchObject({ conflicted: 1 });
  });

  it("skip leaves the file; retry re-plans against the current version", async () => {
    const planId = await engine.createPlan({
      spaceId: 1,
      source: "agent",
      actor: "agent:u1",
      summary: "x",
      steps: [
        { fileId: id("Downloads/a.pdf"), action: "move", to: "X/a.pdf" },
        { fileId: id("Downloads/b.pdf"), action: "move", to: "X/b.pdf" },
      ],
    });
    adapter.edit("Downloads/a.pdf", "edited");
    adapter.edit("Downloads/b.pdf", "edited");
    await engine.approve(planId, owner);
    await engine.execute(planId);

    await engine.resolveConflict(planId, 0, "skip", owner);
    await engine.resolveConflict(planId, 1, "retry", owner);
    expect((await store.getPlan(planId))!.status).toBe("approved");
    const res = await engine.execute(planId);
    expect(res).toMatchObject({ status: "executed", done: 1 });
    expect(adapter.paths()).toEqual(expect.arrayContaining(["Downloads/a.pdf", "X/b.pdf"]));
    expect((await store.getPlan(planId))!.steps.map((s) => s.status)).toEqual(["skipped", "done"]);
  });

  it("a viewer can't resolve conflicts", async () => {
    const planId = await engine.createPlan({ spaceId: 1, source: "agent", actor: "agent:u1", summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "move", to: "X/a.pdf" }] });
    adapter.edit("Downloads/a.pdf", "edited");
    await engine.approve(planId, owner);
    await engine.execute(planId);
    await expect(engine.resolveConflict(planId, 0, "retry", viewer)).rejects.toBeInstanceOf(EngineError);
  });
});

describe("resumable and idempotent", () => {
  it("a crash before the index write resumes without moving twice or double-auditing", async () => {
    const planId = await engine.createPlan({
      spaceId: 1,
      source: "user",
      actor: "user:u1",
      summary: "x",
      steps: [
        { fileId: id("Downloads/a.pdf"), action: "move", to: "X/a.pdf" },
        { fileId: id("Downloads/b.pdf"), action: "move", to: "X/b.pdf" },
      ],
    });
    await engine.approve(planId, owner);
    store.crashNextCommit = true; // the first move reaches storage, but its index/audit write is lost
    const first = await engine.execute(planId);
    expect(first.failed).toBe(1);
    expect(adapter.paths()).toContain("X/a.pdf");
    expect(store.file(id("Downloads/a.pdf")).path).toBe("Downloads/a.pdf"); // rolled back
    expect(store.state.audit).toHaveLength(1); // only b

    // The person retries the failed step.
    await engine.resolveConflict(planId, 0, "retry", owner);
    const second = await engine.execute(planId);
    expect(second).toMatchObject({ done: 1, status: "executed" });
    expect(adapter.writes.filter((w) => w.startsWith("move Downloads/a.pdf"))).toHaveLength(1);
    expect(store.file(id("Downloads/a.pdf")).path).toBe("X/a.pdf");
    expect(store.state.audit).toHaveLength(2);
  });

  it("re-executing a finished plan does nothing", async () => {
    const res = await engine.run({ spaceId: 1, summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "move", to: "X/a.pdf" }] }, owner);
    const again = await engine.execute(res.planId);
    expect(again).toMatchObject({ done: 0, status: "executed" });
    expect(adapter.writes).toHaveLength(2); // mkdir X + move
    expect(store.state.audit).toHaveLength(1);
  });
});

describe("undo", () => {
  it("undoes a whole batch newest-first as an inverse plan, with new audit events", async () => {
    const res = await engine.run(
      {
        spaceId: 1,
        summary: "Organize",
        steps: [
          { fileId: id("Downloads/a.pdf"), action: "move", to: "Y/a.pdf" },
          { fileId: id("Downloads/a.pdf"), action: "rename", to: "Y/renamed.pdf" },
          { fileId: id("Downloads/a.pdf"), action: "caption", to: "A caption" },
          { fileId: id("Downloads/b.pdf"), action: "category", to: "Invoices" },
          { fileId: id("Downloads/b.pdf"), action: "flag", to: "review" },
        ],
      },
      owner,
    );
    expect(store.file(id("Downloads/a.pdf")).path).toBe("Y/renamed.pdf");
    const originals = structuredClone(store.state.audit);

    const undo = await engine.undo({ batchId: res.batchId }, owner);
    expect(undo).toMatchObject({ status: "executed", done: 5 });
    expect(store.file(id("Downloads/a.pdf"))).toMatchObject({ path: "Downloads/a.pdf", caption: "" });
    expect(store.file(id("Downloads/b.pdf"))).toMatchObject({ status: "indexed" });
    expect(store.file(id("Downloads/b.pdf")).category).toBeUndefined();
    expect(adapter.paths()).toContain("Downloads/a.pdf");

    // Append-only: the original events are untouched; undo events point at them.
    expect(store.state.audit.slice(0, 5)).toEqual(originals);
    const undoEvents = store.state.audit.slice(5);
    expect(undoEvents.map((e) => e.action)).toEqual(["undo", "undo", "undo", "undo", "undo"]);
    expect(undoEvents.map((e) => e.undoesEventId)).toEqual([...originals].reverse().map((e) => e.id));
    expect(undoEvents.every((e) => e.actor === "user:u1")).toBe(true);
  });

  it("undoes a single event", async () => {
    await engine.run(
      {
        spaceId: 1,
        summary: "x",
        steps: [
          { fileId: id("Downloads/a.pdf"), action: "tag", to: "one" },
          { fileId: id("Downloads/a.pdf"), action: "caption", to: "cap" },
        ],
      },
      owner,
    );
    const captionEvent = store.state.audit[1]!;
    await engine.undo({ eventIds: [captionEvent.id] }, owner);
    expect(store.file(id("Downloads/a.pdf"))).toMatchObject({ tags: ["one"], caption: "" });
  });

  it("undoes everything the agent did since a time, leaving the user's changes", async () => {
    await engine.run({ spaceId: 1, summary: "mine", steps: [{ fileId: id("Downloads/b.pdf"), action: "tag", to: "mine" }] }, owner);
    const since = clock;
    for (const [path, to] of [
      ["Downloads/a.pdf", "Agent/a.pdf"],
      ["Downloads/c.jpg", "Agent/c.jpg"],
    ] as const) {
      const p = await engine.createPlan({ spaceId: 1, source: "agent", actor: "agent:u1", summary: "agent", steps: [{ fileId: id(path), action: "move", to }] });
      await engine.approve(p, owner);
      await engine.execute(p);
    }
    const res = await engine.undo({ since, actorPrefix: "agent:" }, owner);
    expect(res.done).toBe(2);
    expect(adapter.paths()).toEqual(expect.arrayContaining(["Downloads/a.pdf", "Downloads/c.jpg"]));
    expect(store.file(id("Downloads/b.pdf")).tags).toEqual(["mine"]);
  });

  it("refuses to overwrite: a file changed after the action is reported as a conflict", async () => {
    const res = await engine.run({ spaceId: 1, summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "move", to: "Y/a.pdf" }] }, owner);
    adapter.edit("Y/a.pdf", "edited later");
    const undo = await engine.undo({ batchId: res.batchId }, owner);
    expect(undo).toMatchObject({ conflicted: 1, done: 0, status: "partially_failed" });
    expect(adapter.paths()).toContain("Y/a.pdf");
  });

  it("refuses to undo metadata that was changed again since", async () => {
    const res = await engine.run({ spaceId: 1, summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "caption", to: "first" }] }, owner);
    await engine.run({ spaceId: 1, summary: "y", steps: [{ fileId: id("Downloads/a.pdf"), action: "caption", to: "second" }] }, owner);
    const undo = await engine.undo({ batchId: res.batchId }, owner);
    expect(undo.conflicted).toBe(1);
    expect(store.file(id("Downloads/a.pdf")).caption).toBe("second");
  });

  it("undo of a trash restores the file; undo of undo is refused; undoing twice is a no-op", async () => {
    const res = await engine.run({ spaceId: 1, summary: "Trash", steps: [{ fileId: id("Downloads/a.pdf"), action: "trash" }] }, owner);
    await engine.undo({ batchId: res.batchId }, owner);
    expect(adapter.paths()).toContain("Downloads/a.pdf");
    expect(store.file(id("Downloads/a.pdf")).status).toBe("indexed");

    await expect(engine.undo({ batchId: res.batchId }, owner)).rejects.toThrow(/nothing left/);
    const undoEvent = store.state.audit.find((e) => e.action === "undo")!;
    await expect(engine.undo({ eventIds: [undoEvent.id] }, owner)).rejects.toThrow(/nothing left/);
  });

  it("the agent can propose an undo but not one that trashes or restores", async () => {
    const tagged = await engine.run({ spaceId: 1, summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "tag", to: "t" }] }, owner);
    const planId = await engine.planUndo({ batchId: tagged.batchId }, { source: "agent", actor: "agent:u1" });
    expect((await store.getPlan(planId!))!.status).toBe("pending");

    const trashed = await engine.run({ spaceId: 1, summary: "x", steps: [{ fileId: id("Downloads/b.pdf"), action: "trash" }] }, owner);
    await expect(engine.planUndo({ batchId: trashed.batchId }, { source: "agent", actor: "agent:u1" })).rejects.toThrow(/Only a person/);
  });

  it("undoes rule creation and rule edits", async () => {
    const rule = { type: "structured", name: "Screenshots", enabled: true, priority: 1, match: "all", conditions: [], actions: [], createdBy: "user", createdAt: 0 };
    const created = await engine.run({ spaceId: 1, summary: "Rule", steps: [{ action: "rule_create", to: JSON.stringify(rule) }] }, owner);
    const ruleId = [...store.state.rules.values()][0]!.id;
    await engine.run({ spaceId: 1, summary: "Rename rule", steps: [{ action: "rule_update", to: JSON.stringify({ id: ruleId, changes: { name: "Shots" } }) }] }, owner);
    expect((await store.getRule(ruleId))!.name).toBe("Shots");
    await engine.undo({ since: 0 }, owner);
    expect(store.state.rules.size).toBe(0);
    expect(created.done).toBe(1);
  });
});

describe("canAutoRun", () => {
  const steps = (n: number, action: StepAction = "move") => Array.from({ length: n }, (_, i) => ({ fileId: i, action, seq: i, status: "pending" as const }));
  const settings = { maxFiles: 5, allowMcp: false };

  it("auto-runs small agent plans only under the threshold", () => {
    expect(canAutoRun({ source: "agent", steps: steps(5) }, settings)).toBe(true);
    expect(canAutoRun({ source: "agent", steps: steps(6) }, settings)).toBe(false);
    expect(canAutoRun({ source: "agent", steps: steps(1) }, { ...settings, maxFiles: 0 })).toBe(false);
  });
  it("MCP needs the extra opt-in; rules need auto mode", () => {
    expect(canAutoRun({ source: "mcp", steps: steps(1) }, settings)).toBe(false);
    expect(canAutoRun({ source: "mcp", steps: steps(1) }, { ...settings, allowMcp: true })).toBe(true);
    expect(canAutoRun({ source: "rule", steps: steps(50) }, settings, "auto")).toBe(true);
    expect(canAutoRun({ source: "rule", steps: steps(1) }, settings, "suggest")).toBe(false);
  });
  it("never auto-runs trash", () => {
    expect(canAutoRun({ source: "user", steps: steps(1, "trash") }, settings)).toBe(false);
  });
});

describe("auto rules", () => {
  const ruleBase = { type: "structured" as const, enabled: true, priority: 1, match: "all" as const, conditions: [], actions: [], createdBy: "user" as const, createdAt: 0 };
  it("autoApprove runs plans of rules set to auto, and refuses everything else", async () => {
    const autoId = await store.createRule({ ...ruleBase, name: "Auto", mode: "auto" });
    const suggestId = await store.createRule({ ...ruleBase, name: "Suggest" });
    const autoPlan = await engine.createPlan({ spaceId: 1, source: "rule", actor: `rule:${autoId}`, summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "tag", to: "auto" }] });
    await engine.autoApprove(autoPlan);
    expect(await engine.execute(autoPlan)).toMatchObject({ status: "executed", done: 1 });
    const plan = (await store.getPlan(autoPlan))!;
    expect(plan.approvedBy).toBeUndefined();
    expect(store.state.audit.at(-1)).toMatchObject({ actor: `rule:${autoId}`, action: "tag" });

    const suggestPlan = await engine.createPlan({ spaceId: 1, source: "rule", actor: `rule:${suggestId}`, summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "tag", to: "s" }] });
    await expect(engine.autoApprove(suggestPlan)).rejects.toThrow(/set to suggest/);
    const agentPlan = await engine.createPlan({ spaceId: 1, source: "agent", actor: "agent:u1", summary: "x", steps: [{ fileId: id("Downloads/a.pdf"), action: "tag", to: "s" }] });
    await expect(engine.autoApprove(agentPlan)).rejects.toThrow(/Only plans from an enabled rule/);
    await store.putRule({ ...(await store.getRule(autoId))!, enabled: false });
    const disabled = await engine.createPlan({ spaceId: 1, source: "rule", actor: `rule:${autoId}`, summary: "x", steps: [{ fileId: id("Downloads/b.pdf"), action: "tag", to: "s" }] });
    await expect(engine.autoApprove(disabled)).rejects.toThrow(/enabled rule/);
  });
});
