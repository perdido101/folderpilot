import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@folderpilot/ai";

let script: AgentEvent[] = [];
let seenHistory: unknown[] = [];
vi.mock("@/lib/agent/agent", () => ({
  deviceAgent: async function* (_root: number, history: unknown[]) {
    seenHistory = history;
    for (const e of script) yield e;
  },
  serverAgent: async function* () {
    yield { type: "error", message: "No AI is connected for this organization." } satisfies AgentEvent;
  },
}));
import { useChat } from "./chat";

// The tests run in Node: a minimal sessionStorage.
const mem = new Map<string, string>();
vi.stubGlobal("sessionStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), clear: () => mem.clear() });

const scope = { kind: "device" as const, rootId: 1 };
const conv = () => useChat.getState().conversations["device:1"]!;

beforeEach(() => {
  sessionStorage.clear();
  useChat.setState({ conversations: {}, busyKey: null, controller: null, attachments: [] });
});

describe("chat store", () => {
  it("streams text, tool chips, plans and files into one assistant message, then keeps the history", async () => {
    script = [
      { type: "tool", id: "t1", name: "search_files", status: "running" },
      { type: "tool", id: "t1", name: "search_files", status: "done", summary: "Found 2 files" },
      { type: "files", fileIds: ["4", "5"] },
      { type: "plan", planId: "9" },
      { type: "text", text: "Waiting " },
      { type: "text", text: "for approval." },
      { type: "done", reply: "Waiting for approval.", history: [{ role: "user", content: "hi" }, { role: "assistant", content: "Waiting for approval." }], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" },
    ];
    await useChat.getState().send(scope, "hi");
    const [user, reply] = conv().messages;
    expect(user).toMatchObject({ role: "user", text: "hi" });
    expect(reply).toMatchObject({ role: "assistant", text: "Waiting for approval.", planIds: ["9"], fileIds: ["4", "5"], streaming: false });
    expect(reply!.tools).toEqual([{ id: "t1", name: "search_files", status: "done", summary: "Found 2 files" }]);
    expect(conv().history).toHaveLength(2);
    expect(useChat.getState().busyKey).toBeNull();
    // Persisted for this tab, and replayed next turn.
    expect(JSON.parse(sessionStorage.getItem("fp-chat:device:1")!).messages).toHaveLength(2);
    script = [{ type: "done", reply: "ok", history: [], usage: { inputTokens: 0, outputTokens: 0 }, model: "m" }];
    await useChat.getState().send(scope, "again");
    expect(seenHistory).toHaveLength(2);
  });

  it("shows errors and drops the empty assistant bubble", async () => {
    await useChat.getState().send({ kind: "server", orgId: "o", spaceId: "s" }, "hello");
    const msgs = useChat.getState().conversations["server:s"]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "error"]);
    expect(msgs[1]!.text).toMatch(/No AI is connected/);
  });

  it("attachments go with the next message only", async () => {
    script = [{ type: "done", reply: "ok", history: [], usage: { inputTokens: 0, outputTokens: 0 }, model: "m" }];
    useChat.getState().attach([3, "7"]);
    await useChat.getState().send(scope, "what are these?");
    expect(conv().messages[0]!.fileIds).toEqual(["3", "7"]);
    expect(useChat.getState().attachments).toEqual([]);
  });
});
