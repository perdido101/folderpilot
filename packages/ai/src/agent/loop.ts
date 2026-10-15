/**
 * The agent loop, shared by every runtime: model → tools → model, streamed as events so the UI can show text as it is
 * written and each tool call as it runs. Tools are injected (Dexie in the browser, Postgres on the server).
 */
import { AIError, ZERO_USAGE, type AIProvider, type ChatMessage, type ChatResult, type Usage } from "../types";
import { AGENT_TOOL_NAMES, AGENT_TOOLS } from "./tools";

export interface ToolOutcome {
  /** JSON-serializable result given back to the model. */
  result: unknown;
  /** One line for the UI, e.g. "Found 12 files". */
  summary?: string;
  /** Plans proposed by this call (shown as Plan Cards). */
  planIds?: string[];
  /** Files surfaced by this call (shown as chips). */
  fileIds?: string[];
}

export interface AgentToolRunner {
  run(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; status: "running" | "done" | "error"; summary?: string }
  | { type: "plan"; planId: string }
  | { type: "files"; fileIds: string[] }
  | { type: "done"; reply: string; history: ChatMessage[]; usage: Usage; model: string }
  | { type: "error"; message: string };

export interface RunAgentOptions {
  provider: AIProvider;
  system: string;
  tools: AgentToolRunner;
  history: ChatMessage[];
  userText: string;
  signal?: AbortSignal;
  maxRounds?: number;
  /** Stop starting new rounds after this long (ms). */
  timeBudgetMs?: number;
  /** Tool results larger than this are cut before they go back to the model. */
  maxToolChars?: number;
  /** Called once per tool call (for the tool-call log). */
  onToolCall?: (call: { name: string; input: Record<string, unknown>; ok: boolean; error?: string; ms: number }) => void | Promise<void>;
  now?: () => number;
}

export const STOPPED_REPLY = "I stopped before finishing. Ask again, or narrow the request.";

function cap(json: string, max: number): string {
  if (json.length <= max) return json;
  return JSON.stringify({ truncated: true, note: `Result cut to ${max} characters; narrow the query or use a smaller limit.`, partial: json.slice(0, max) });
}

const addUsage = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { provider, system, tools, signal } = opts;
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + (opts.timeBudgetMs ?? 120_000);
  const maxRounds = opts.maxRounds ?? 8;
  const maxChars = opts.maxToolChars ?? 12_000;
  const messages: ChatMessage[] = [...opts.history, { role: "user", content: opts.userText }];
  let usage = ZERO_USAGE;
  let model = "";

  try {
    for (let round = 0; round < maxRounds && now() < deadline; round++) {
      let done: ChatResult | null = null;
      for await (const ev of provider.chat(system, messages, AGENT_TOOLS, signal ? { signal } : {})) {
        if (signal?.aborted) throw new AIError("Stopped.");
        if (ev.type === "text") yield { type: "text", text: ev.text };
        else done = ev;
      }
      if (!done) throw new AIError("The AI stream ended without a result.");
      usage = addUsage(usage, done.usage);
      model = done.model;
      messages.push({ role: "assistant", content: done.content, toolCalls: done.toolCalls, raw: done.raw });
      if (done.toolCalls.length === 0) {
        yield { type: "done", reply: done.content, history: messages, usage, model };
        return;
      }
      for (const call of done.toolCalls) {
        if (signal?.aborted) throw new AIError("Stopped.");
        yield { type: "tool", id: call.id, name: call.name, status: "running" };
        const started = now();
        let content: string;
        let isError = false;
        if (!AGENT_TOOL_NAMES.has(call.name)) {
          isError = true;
          content = JSON.stringify({ error: `There is no tool called "${call.name}" (and there is no delete tool). Use flag_for_deletion for files that look useless.` });
          yield { type: "tool", id: call.id, name: call.name, status: "error", summary: "Not a FolderPilot tool" };
          await opts.onToolCall?.({ name: call.name, input: call.input, ok: false, error: "unknown tool", ms: 0 });
        } else {
          try {
            const out = await tools.run(call.name, call.input ?? {});
            content = cap(JSON.stringify(out.result ?? null), maxChars);
            yield { type: "tool", id: call.id, name: call.name, status: "done", ...(out.summary ? { summary: out.summary } : {}) };
            if (out.fileIds?.length) yield { type: "files", fileIds: out.fileIds };
            for (const planId of out.planIds ?? []) yield { type: "plan", planId };
            await opts.onToolCall?.({ name: call.name, input: call.input, ok: true, ms: now() - started });
          } catch (err) {
            isError = true;
            const message = err instanceof Error ? err.message : String(err);
            content = JSON.stringify({ error: message });
            yield { type: "tool", id: call.id, name: call.name, status: "error", summary: message };
            await opts.onToolCall?.({ name: call.name, input: call.input, ok: false, error: message, ms: now() - started });
          }
        }
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content, isError });
      }
    }
    messages.push({ role: "assistant", content: STOPPED_REPLY });
    yield { type: "done", reply: STOPPED_REPLY, history: messages, usage, model };
  } catch (err) {
    yield { type: "error", message: signal?.aborted ? "Stopped." : err instanceof Error ? err.message : String(err) };
  }
}

/** A short, content-free description of tool input for the tool-call log (no file contents, capped). */
export function summarizeToolInput(input: Record<string, unknown>, max = 300): string {
  const s = JSON.stringify(input, (_k, v) => (Array.isArray(v) && v.length > 10 ? [...v.slice(0, 10), `…+${v.length - 10}`] : typeof v === "string" && v.length > 80 ? `${v.slice(0, 80)}…` : v));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
