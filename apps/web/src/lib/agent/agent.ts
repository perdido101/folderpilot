/**
 * The agent as a stream of events, for whatever is open:
 * - a folder on this device: the shared loop runs here, tools run on the browser index;
 * - a server space: the server runs the loop and its tools, and streams the same events (SSE).
 */
import { agentSystemPrompt, runAgent, summarizeToolInput, type AgentEvent, type ChatMessage } from "@folderpilot/ai";
import i18n from "@/i18n";
import { db } from "../db";
import { browserProvider } from "../ai/provider";
import { keywordSearch } from "../search";
import { getSettings } from "../settings";
import { ApiError } from "../api";
import { createDeviceTools } from "./device-tools";

export type { AgentEvent };

/** Folder on this device. Without an AI it still finds files by keyword. */
export async function* deviceAgent(rootId: number, history: ChatMessage[], userText: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const settings = await getSettings();
  const provider = browserProvider(settings.ai);
  const root = await db.roots.get(rootId);

  if (!provider) {
    const hits = keywordSearch(await db.files.where("rootId").equals(rootId).toArray(), userText).slice(0, 12);
    const reply = hits.length
      ? hits.length === 12
        ? i18n.t("agent:replies.offlineTopMatches")
        : i18n.t("agent:replies.offlineFound", { count: hits.length })
      : i18n.t("agent:replies.offlineNone");
    if (hits.length) yield { type: "files", fileIds: hits.map((h) => String(h.file.id)) };
    yield { type: "text", text: reply };
    yield { type: "done", reply, history: [...history, { role: "user", content: userText }, { role: "assistant", content: reply }], usage: { inputTokens: 0, outputTokens: 0 }, model: "" };
    return;
  }

  yield* runAgent({
    provider,
    system: agentSystemPrompt({ spaceName: root?.name ?? "this folder", today: new Date().toISOString().slice(0, 10), canApprove: true, where: "device" }),
    tools: createDeviceTools(rootId, { provider }),
    history,
    userText,
    ...(signal ? { signal } : {}),
    onToolCall: async (call) => {
      await db.agentLog.add({ at: Date.now(), rootId, tool: call.name, input: summarizeToolInput(call.input ?? {}), ok: call.ok, ...(call.error ? { error: call.error } : {}), durationMs: Math.round(call.ms) } as never);
    },
  });
}

/** Parse a `text/event-stream` body into its `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
}

/** Server space: the server runs the agent with its tools; we render its events. */
export async function* serverAgent(orgId: string, spaceId: string, history: ChatMessage[], userText: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/orgs/${orgId}/spaces/${spaceId}/agent`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: userText, history }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    yield { type: "error", message: signal?.aborted ? "Stopped." : err instanceof Error ? err.message : String(err) };
    return;
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    yield { type: "error", message: new ApiError(res.status, body?.message ?? res.statusText).message };
    return;
  }
  try {
    for await (const data of sseData(res.body)) yield JSON.parse(data) as AgentEvent;
  } catch (err) {
    yield { type: "error", message: signal?.aborted ? "Stopped." : err instanceof Error ? err.message : String(err) };
  }
}
