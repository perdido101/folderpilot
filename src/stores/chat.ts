import { create } from "zustand";
import type { ChatMessage } from "@/lib/ai/types";
import { runAgentTurn } from "@/lib/agent/agent";

export interface UIMessage {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
  planIds: number[];
  fileIds: number[];
}

interface ChatState {
  rootId: number | null;
  messages: UIMessage[];
  /** Provider-level history (tool calls included), replayed on every turn. */
  history: ChatMessage[];
  busy: boolean;
  /** Files dragged into the chat or sent via "Ask agent". */
  attachments: number[];
  attach: (ids: number[]) => void;
  detach: (id: number) => void;
  send: (rootId: number, text: string) => Promise<void>;
  reset: () => void;
}

let nextId = 1;

export const useChat = create<ChatState>()((set, get) => ({
  rootId: null,
  messages: [],
  history: [],
  busy: false,
  attachments: [],
  attach: (ids) => set({ attachments: [...new Set([...get().attachments, ...ids])] }),
  detach: (id) => set({ attachments: get().attachments.filter((a) => a !== id) }),
  reset: () => set({ messages: [], history: [], attachments: [] }),

  send: async (rootId, text) => {
    const trimmed = text.trim();
    if (!trimmed || get().busy) return;
    // Conversations are scoped to one folder.
    if (get().rootId !== rootId) set({ rootId, messages: [], history: [] });
    const attachments = get().attachments;
    const withFiles = attachments.length ? `${trimmed}\n\n[Attached files — ids: ${attachments.join(", ")}]` : trimmed;
    set({ busy: true, attachments: [], messages: [...get().messages, { id: nextId++, role: "user", text: trimmed, planIds: [], fileIds: attachments }] });
    try {
      const turn = await runAgentTurn(rootId, get().history, withFiles);
      set({ history: turn.messages, messages: [...get().messages, { id: nextId++, role: "assistant", text: turn.reply, planIds: turn.planIds, fileIds: turn.fileIds }] });
    } catch (err) {
      set({ messages: [...get().messages, { id: nextId++, role: "error", text: err instanceof Error ? err.message : String(err), planIds: [], fileIds: [] }] });
    } finally {
      set({ busy: false });
    }
  },
}));
