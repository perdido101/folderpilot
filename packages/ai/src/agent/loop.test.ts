import { describe, expect, it } from "vitest";
import type { AIProvider, ChatEvent, ChatMessage, ToolCall } from "../types";
import { runAgent, STOPPED_REPLY, summarizeToolInput, type AgentEvent, type AgentToolRunner } from "./loop";
import { AGENT_TOOLS } from "./tools";
import { agentSystemPrompt } from "./prompt";

/** A provider that plays back scripted turns: text chunks, then tool calls (or none). */
function scripted(turns: { text?: string[]; calls?: ToolCall[] }[]): AIProvider & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return {
    seen,
    label: "fake",
    cacheKey: "fake:1",
    describeImage: () => Promise.reject(new Error("unused")),
    describeText: () => Promise.reject(new Error("unused")),
    async *chat(_system, messages) {
      seen.push([...messages]);
      const turn = turns[Math.min(i++, turns.length - 1)]!;
      for (const t of turn.text ?? []) yield { type: "text", text: t } satisfies ChatEvent;
      yield { type: "done", content: (turn.text ?? []).join(""), toolCalls: turn.calls ?? [], usage: { inputTokens: 10, outputTokens: 2 }, model: "m" } satisfies ChatEvent;
    },
    test: async () => "ok",
  };
}

const collect = async (it: AsyncIterable<AgentEvent>) => {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const tools = (impl: Record<string, (input: Record<string, unknown>) => unknown>): AgentToolRunner & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async run(name, input) {
      calls.push(name);
      const r = impl[name];
      if (!r) throw new Error(`no impl for ${name}`);
      return (await r(input)) as never;
    },
  };
};

describe("agent loop", () => {
  it("streams text, runs tools, surfaces plans and files, and returns the history", async () => {
    const provider = scripted([
      { text: ["Let me ", "look."], calls: [{ id: "c1", name: "search_files", input: { query: "invoice" } }] },
      { calls: [{ id: "c2", name: "propose_plan", input: { summary: "Tag", steps: [] } }] },
      { text: ["Waiting for ", "your approval."] },
    ]);
    const runner = tools({
      search_files: () => ({ result: { total: 1 }, summary: "Found 1 file", fileIds: ["f1"] }),
      propose_plan: () => ({ result: { planId: "p1" }, summary: "Plan ready", planIds: ["p1"] }),
    });
    const logged: string[] = [];
    const events = await collect(runAgent({ provider, system: "s", tools: runner, history: [], userText: "tag invoices", onToolCall: (c) => void logged.push(`${c.name}:${c.ok}`) }));
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("Let me look.Waiting for your approval.");
    expect(events.filter((e) => e.type === "tool").map((e) => `${(e as { name: string }).name}:${(e as { status: string }).status}`)).toEqual([
      "search_files:running",
      "search_files:done",
      "propose_plan:running",
      "propose_plan:done",
    ]);
    expect(events).toContainEqual({ type: "files", fileIds: ["f1"] });
    expect(events).toContainEqual({ type: "plan", planId: "p1" });
    const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.reply).toBe("Waiting for your approval.");
    expect(done.usage).toEqual({ inputTokens: 30, outputTokens: 6 });
    expect(done.history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    expect(logged).toEqual(["search_files:true", "propose_plan:true"]);
    // The second model call sees the tool result.
    expect(provider.seen[1]!.at(-1)).toMatchObject({ role: "tool", name: "search_files", isError: false });
  });

  it("refuses unknown tools such as delete, and passes tool errors back to the model", async () => {
    const provider = scripted([{ calls: [{ id: "c1", name: "delete_files", input: { ids: ["1"] } }, { id: "c2", name: "get_file", input: { id: "x" } }] }, { text: ["Sorry."] }]);
    const runner = tools({ get_file: () => Promise.reject(new Error("File x is not in this space")) });
    const events = await collect(runAgent({ provider, system: "s", tools: runner, history: [], userText: "delete" }));
    expect(runner.calls).toEqual(["get_file"]);
    const results = provider.seen[1]!.filter((m) => m.role === "tool");
    expect(results[0]).toMatchObject({ isError: true });
    expect((results[0] as { content: string }).content).toMatch(/no delete tool/);
    expect((results[1] as { content: string }).content).toMatch(/not in this space/);
    expect(events.filter((e) => e.type === "tool" && e.status === "error")).toHaveLength(2);
  });

  it("stops after the round limit and caps large tool results", async () => {
    const provider = scripted([{ calls: [{ id: "c", name: "list_files", input: {} }] }]);
    const runner = tools({ list_files: () => ({ result: { big: "x".repeat(50_000) } }) });
    const events = await collect(runAgent({ provider, system: "s", tools: runner, history: [], userText: "list", maxRounds: 3, maxToolChars: 1000 }));
    expect(runner.calls).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "done", reply: STOPPED_REPLY });
    const tool = provider.seen[1]!.at(-1) as { content: string };
    expect(tool.content.length).toBeLessThan(1300);
    expect(JSON.parse(tool.content).truncated).toBe(true);
  });

  it("ends with an error event when stopped", async () => {
    const ctrl = new AbortController();
    const provider = scripted([{ calls: [{ id: "c", name: "list_files", input: {} }] }]);
    const runner = tools({ list_files: () => (ctrl.abort(), { result: {} }) });
    const events = await collect(runAgent({ provider, system: "s", tools: runner, history: [], userText: "x", signal: ctrl.signal }));
    expect(events.at(-1)).toEqual({ type: "error", message: "Stopped." });
  });
});

describe("tools and prompt", () => {
  it("offers exactly the spec tools: no delete, no trash, no approve", () => {
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual(
      ["explain_categorization", "flag_for_deletion", "get_audit", "get_file", "list_files", "propose_plan", "propose_rule", "propose_undo", "search_files", "stats", "update_rule_proposal"].sort(),
    );
    expect(AGENT_TOOLS.some((t) => /delete_|trash|approve/.test(t.name))).toBe(false);
  });

  it("prompt is English-only and says who can approve", () => {
    const p = agentSystemPrompt({ spaceName: "Office", today: "2026-10-15", canApprove: false, where: "server" });
    expect(p).toContain("Always reply in English");
    expect(p).toContain("can't approve plans");
    expect(p).toContain("no tool for it");
  });

  it("summarizes tool input without long text", () => {
    const s = summarizeToolInput({ query: "a".repeat(500), ids: Array.from({ length: 30 }, (_, i) => i) });
    expect(s.length).toBeLessThanOrEqual(301);
    expect(s).toContain("…");
  });
});
