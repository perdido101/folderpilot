/**
 * Agent conversations, one per folder on this device or server space. Assistant replies stream in as they are written,
 * with a chip per tool call; plans come back as Plan Cards. Kept in sessionStorage so a reload keeps the conversation.
 */
import { create } from "zustand";
import type { AgentEvent, ChatMessage } from "@folderpilot/ai";
import { deviceAgent, serverAgent } from "@/lib/agent/agent";

export type ChatScope = { kind: "device"; rootId: number } | { kind: "server"; orgId: string; spaceId: string };

export const scopeKey = (s: ChatScope) => (s.kind === "device" ? `device:${s.rootId}` : `server:${s.spaceId}`);

export interface ToolChip {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary?: string;
}

export interface UIMessage {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
  planIds: string[];
  fileIds: string[];
  tools: ToolChip[];
  /** Still being written. */
  streaming?: boolean;
}

interface Conversation {
  messages: UIMessage[];
  /** Provider-level history (tool calls included), replayed on every turn. */
  history: ChatMessage[];
}

interface ChatState {
  conversations: Record<string, Conversation>;
  busyKey: string | null;
  controller: AbortController | null;
  /** Files dragged into the chat or sent via "Ask agent" (ids as strings). */
  attachments: string[];
  attach: (ids: (string | number)[]) => void;
  detach: (id: string) => void;
  send: (scope: ChatScope, text: string) => Promise<void>;
  stop: () => void;
  reset: (scope: ChatScope) => void;
}

const STORAGE = "fp-chat:";
const MAX_HISTORY = 120;
let nextId = Date.now();

function load(key: string): Conversation {
  try {
    const raw = sessionStorage.getItem(STORAGE + key);
    if (raw) return JSON.parse(raw) as Conversation;
  } catch {
    // Storage unavailable (private mode, tests): start fresh.
  }
  return { messages: [], history: [] };
}
function save(key: string, c: Conversation) {
  try {
    sessionStorage.setItem(STORAGE + key, JSON.stringify(c));
  } catch {
    // Quota or unavailable: the conversation still lives in memory.
  }
}

/** Events from the right runtime for this scope. */
export function eventsFor(scope: ChatScope, history: ChatMessage[], text: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
  return scope.kind === "device" ? deviceAgent(scope.rootId, history, text, signal) : serverAgent(scope.orgId, scope.spaceId, history, text, signal);
}

export const useChat = create<ChatState>()((set, get) => {
  const conv = (key: string) => get().conversations[key] ?? load(key);
  const put = (key: string, c: Conversation) => set({ conversations: { ...get().conversations, [key]: c } });
  const patchLast = (key: string, fn: (m: UIMessage) => UIMessage) => {
    const c = conv(key);
    put(key, { ...c, messages: c.messages.map((m, i) => (i === c.messages.length - 1 ? fn(m) : m)) });
  };

  return {
    conversations: {},
    busyKey: null,
    controller: null,
    attachments: [],
    attach: (ids) => set({ attachments: [...new Set([...get().attachments, ...ids.map(String)])] }),
    detach: (id) => set({ attachments: get().attachments.filter((a) => a !== id) }),
    stop: () => get().controller?.abort(),
    reset: (scope) => {
      const key = scopeKey(scope);
      put(key, { messages: [], history: [] });
      save(key, { messages: [], history: [] });
      set({ attachments: [] });
    },

    send: async (scope, text) => {
      const trimmed = text.trim();
      if (!trimmed || get().busyKey) return;
      const key = scopeKey(scope);
      const attachments = get().attachments;
      const withFiles = attachments.length ? `${trimmed}\n\n[Attached files — ids: ${attachments.join(", ")}]` : trimmed;
      const start = conv(key);
      const controller = new AbortController();
      put(key, {
        ...start,
        messages: [
          ...start.messages,
          { id: nextId++, role: "user", text: trimmed, planIds: [], fileIds: attachments, tools: [] },
          { id: nextId++, role: "assistant", text: "", planIds: [], fileIds: [], tools: [], streaming: true },
        ],
      });
      set({ busyKey: key, controller, attachments: [] });
      let ended = false;
      try {
        for await (const ev of eventsFor(scope, start.history, withFiles, controller.signal)) {
          switch (ev.type) {
            case "text":
              patchLast(key, (m) => ({ ...m, text: m.text + ev.text }));
              break;
            case "tool":
              patchLast(key, (m) => {
                const exists = m.tools.some((x) => x.id === ev.id);
                const chip: ToolChip = { id: ev.id, name: ev.name, status: ev.status, ...(ev.summary ? { summary: ev.summary } : {}) };
                return { ...m, tools: exists ? m.tools.map((x) => (x.id === ev.id ? chip : x)) : [...m.tools, chip] };
              });
              break;
            case "plan":
              patchLast(key, (m) => ({ ...m, planIds: [...m.planIds, ev.planId] }));
              break;
            case "files":
              patchLast(key, (m) => ({ ...m, fileIds: [...new Set([...m.fileIds, ...ev.fileIds])] }));
              break;
            case "done": {
              ended = true;
              patchLast(key, (m) => ({ ...m, text: ev.reply || m.text, streaming: false }));
              const c = conv(key);
              put(key, { ...c, history: ev.history.slice(-MAX_HISTORY) });
              break;
            }
            case "error":
              ended = true;
              patchLast(key, (m) => ({ ...m, streaming: false }));
              put(key, { ...conv(key), messages: [...conv(key).messages, { id: nextId++, role: "error", text: ev.message, planIds: [], fileIds: [], tools: [] }] });
              break;
          }
        }
      } catch (err) {
        ended = true;
        put(key, { ...conv(key), messages: [...conv(key).messages, { id: nextId++, role: "error", text: err instanceof Error ? err.message : String(err), planIds: [], fileIds: [], tools: [] }] });
      } finally {
        if (!ended) patchLast(key, (m) => ({ ...m, streaming: false }));
        // An assistant bubble with nothing in it (stopped before any output) is noise.
        const c = conv(key);
        const cleaned = c.messages.filter((m) => !(m.role === "assistant" && !m.text && !m.tools.length && !m.planIds.length && !m.fileIds.length));
        put(key, { ...c, messages: cleaned });
        save(key, { messages: cleaned, history: c.history });
        set({ busyKey: null, controller: null });
      }
    },
  };
});

/** The conversation for a scope (loads it from sessionStorage the first time). */
export function useConversation(scope: ChatScope | null): Conversation {
  return useChat((s) => (scope ? (s.conversations[scopeKey(scope)] ?? EMPTY) : EMPTY));
}
const EMPTY: Conversation = { messages: [], history: [] };

/** Make sure a scope's saved conversation is in memory (call when the scope becomes active). */
export function hydrate(scope: ChatScope) {
  const key = scopeKey(scope);
  const state = useChat.getState();
  if (!state.conversations[key]) useChat.setState({ conversations: { ...state.conversations, [key]: load(key) } });
}
