import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  tone: "default" | "success" | "error";
  /** Primary action, e.g. Undo or "Make this a rule?". */
  action?: { label: string; run: () => void | Promise<void> };
}

interface ToastState {
  toasts: Toast[];
  show: (t: Omit<Toast, "id">, ms?: number) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  show: (t, ms = 7000) => {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    window.setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (message: string, tone: Toast["tone"] = "default", action?: Toast["action"]) => useToasts.getState().show({ message, tone, action });
