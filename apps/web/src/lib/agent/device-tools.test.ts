import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, type AgentEvent, type AIProvider, type ChatEvent, type ToolCall } from "@folderpilot/ai";
import { db, type NewFileRecord } from "../db";
import { registerRootHandle } from "../file-access-cache";
import { asDir, FakeDirHandle } from "@/test/fake-fs";

vi.mock("@/stores/toasts", () => ({ toast: () => 0 }));
import { createDeviceTools } from "./device-tools";
import { runUserAction } from "../actions/engine";
import { saveSettings } from "../settings";

let root: FakeDirHandle;
let rootId: number;

async function addFile(path: string, extra: Partial<NewFileRecord> = {}) {
  const handle = await root.put(path, `content of ${path}`);
  const disk = await handle.getFile();
  const name = path.split("/").pop()!;
  return db.files.add({ rootId, path, name, ext: name.split(".").pop()!, kind: name.endsWith(".jpg") ? "image" : "document", size: disk.size, mtime: Date.parse("2026-03-01"), status: "analyzed", flags: [], tags: [], ...extra });
}

beforeEach(async () => {
  await Promise.all([db.files.clear(), db.roots.clear(), db.audit.clear(), db.plans.clear(), db.rules.clear(), db.trash.clear(), db.agentLog.clear(), db.settings.clear()]);
  root = new FakeDirHandle("root");
  rootId = await db.roots.add({ name: "Office", handle: {} as FileSystemDirectoryHandle, addedAt: 0 });
  registerRootHandle(rootId, asDir(root));
});

const run = (name: string, input: Record<string, unknown>) => createDeviceTools(rootId).run(name, input);

describe("device agent tools", () => {
  it("search, list, get and stats stay inside the folder", async () => {
    const inv = await addFile("Invoices/inv-1001.pdf", { category: "Invoices", client: "Alpha Ltd", caption: "Invoice for Alpha" });
    await addFile("Photos/beach.jpg", { category: "Photos", flags: ["duplicate"], mtime: Date.parse("2025-07-01") });
    const otherRoot = await db.roots.add({ name: "Other", addedAt: 0 });
    const secret = await db.files.add({ rootId: otherRoot, path: "secret.pdf", name: "secret.pdf", ext: "pdf", kind: "document", size: 1, mtime: 0, status: "analyzed", flags: [], tags: [] });

    const search = await run("search_files", { query: "alpha invoice" });
    expect(search.fileIds).toEqual([String(inv)]);
    const list = await run("list_files", { kind: "image" });
    expect((list.result as { total: number }).total).toBe(1);
    await expect(run("get_file", { id: secret })).rejects.toThrow(/not in this folder/);
    const stats = await run("stats", { question: "per year", groupBy: "year" });
    expect((stats.result as { groups: unknown[] }).groups).toEqual([
      { key: "2025", value: 1 },
      { key: "2026", value: 1 },
    ]);
    const flags = await run("stats", { question: "dupes", groupBy: "flag", filter: { kind: "image" } });
    expect((flags.result as { groups: unknown[] }).groups).toEqual([{ key: "duplicate", value: 1 }]);
  });

  it("propose_plan creates a pending agent plan; nothing changes until approved", async () => {
    const a = await addFile("a.pdf");
    const out = await run("propose_plan", { summary: "File it", steps: [{ fileId: String(a), action: "move", to: "Invoices" }, { fileId: a, action: "tag", to: "Paid" }] });
    const plan = await db.plans.get(Number(out.planIds![0]));
    expect(plan).toMatchObject({ source: "agent", actor: "agent:local", status: "pending" });
    expect(plan!.steps.map((s) => s.action)).toEqual(["move", "tag"]);
    expect(root.paths()).toContain("a.pdf");
    await expect(run("propose_plan", { summary: "x", steps: [{ fileId: a, action: "delete", to: "" }] })).rejects.toThrow(/no delete/);
  });

  it("flag_for_deletion is a plan, applied by itself only under the auto-run limit, never trashing", async () => {
    const a = await addFile("old.pdf");
    let out = await run("flag_for_deletion", { fileIds: [a], reason: "old" });
    expect((await db.plans.get(Number(out.planIds![0])))!.status).toBe("pending");
    expect((await db.files.get(a))!.flags).toEqual([]);
    await db.plans.update(Number(out.planIds![0]), { status: "cancelled" });

    await saveSettings((s) => ({ ...s, agentAutoRunMaxFiles: 5 }));
    out = await run("flag_for_deletion", { fileIds: [a], reason: "old" });
    expect((await db.plans.get(Number(out.planIds![0])))!.status).toBe("executed");
    const f = (await db.files.get(a))!;
    expect(f.flags).toContain("suggested_delete");
    expect(f.status).not.toBe("trashed");
    expect(root.paths()).toContain("old.pdf");
  });

  it("propose_rule is Suggest-only and can be revised while pending; update_rule_proposal can't make a rule auto", async () => {
    await addFile("Screenshot 1.png", { flags: ["screenshot"] });
    const out = await run("propose_rule", { name: "Shots", conditions: [{ field: "flag", op: "has", value: "screenshot" }], actions: [{ type: "move", value: "Temp" }] });
    expect(out.result).toMatchObject({ wouldMatchNow: 1, mode: "suggest" });
    const revised = await run("update_rule_proposal", { planId: out.planIds![0], changes: { name: "Screenshots to Temp" } });
    expect((await db.plans.get(Number(out.planIds![0])))!.status).toBe("cancelled");
    const plan = (await db.plans.get(Number(revised.planIds![0])))!;
    expect(JSON.parse(plan.steps[0]!.to!)).toMatchObject({ name: "Screenshots to Temp", mode: "suggest", createdBy: "agent" });
    const ruleId = await db.rules.add({ type: "structured", name: "R", enabled: true, priority: 1, match: "all", conditions: [{ field: "ext", op: "is", value: "pdf" }], actions: [{ type: "tag", value: "x" }], createdBy: "user", createdAt: 0 });
    await expect(run("update_rule_proposal", { ruleId, changes: { mode: "auto" } })).rejects.toThrow(/can't make a rule run automatically/);
    await expect(run("propose_rule", { name: "Bad", conditions: [{ field: "name", op: "matches", value: "(a+)+" }], actions: [{ type: "tag", value: "x" }] })).rejects.toThrow();
  });

  it("get_audit filters by actor and propose_undo makes a pending undo plan", async () => {
    const a = await addFile("a.pdf");
    const res = await runUserAction(rootId, "Tag", [{ fileId: a, action: "tag", to: "mine" }]);
    const audit = await run("get_audit", { actor: "user" });
    expect((audit.result as { batchId: string }[])[0]!.batchId).toBe(res.batchId);
    expect(await run("get_audit", { actor: "agent" })).toMatchObject({ result: [] });
    const undo = await run("propose_undo", { batchId: res.batchId });
    expect((await db.plans.get(Number(undo.planIds![0])))!).toMatchObject({ status: "pending", source: "agent" });
    expect((await db.files.get(a))!.tags).toEqual(["mine"]);
  });
});

describe("device agent with the shared loop", () => {
  it("logs every tool call", async () => {
    await addFile("a.pdf");
    const turns: { calls?: ToolCall[]; text?: string }[] = [{ calls: [{ id: "1", name: "list_files", input: {} }, { id: "2", name: "get_file", input: { id: "999" } }] }, { text: "Here they are." }];
    const provider: AIProvider = {
      label: "fake",
      cacheKey: "fake:1",
      describeImage: () => Promise.reject(new Error("unused")),
      describeText: () => Promise.reject(new Error("unused")),
      async *chat() {
        const t = turns.shift()!;
        yield { type: "done", content: t.text ?? "", toolCalls: t.calls ?? [], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" } satisfies ChatEvent;
      },
      test: async () => "ok",
    };
    const events: AgentEvent[] = [];
    for await (const e of runAgent({
      provider,
      system: "s",
      tools: createDeviceTools(rootId),
      history: [],
      userText: "list",
      onToolCall: async (c) => void (await db.agentLog.add({ at: Date.now(), rootId, tool: c.name, input: JSON.stringify(c.input), ok: c.ok, error: c.error, durationMs: c.ms } as never)),
    }))
      events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "done", reply: "Here they are." });
    const log = await db.agentLog.toArray();
    expect(log.map((l) => [l.tool, l.ok])).toEqual([
      ["list_files", true],
      ["get_file", false],
    ]);
  });
});
