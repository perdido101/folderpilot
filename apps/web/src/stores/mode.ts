import { create } from "zustand";

/**
 * "account": signed in to a FolderPilot server (organizations, spaces, roles).
 * "device":  no account — Private mode on this computer only (the browser index).
 * Builds with VITE_LOCAL_ONLY=1 (e.g. GitHub Pages) are always device-only.
 */
export type AppMode = "account" | "device";

export const LOCAL_ONLY = import.meta.env.VITE_LOCAL_ONLY === "1";
const KEY = "fp-mode";

function initial(): AppMode {
  if (LOCAL_ONLY) return "device";
  try {
    return localStorage.getItem(KEY) === "device" ? "device" : "account";
  } catch {
    return "account";
  }
}

interface ModeState {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
}

export const useMode = create<ModeState>()((set) => ({
  mode: initial(),
  setMode: (mode) => {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* storage unavailable */
    }
    set({ mode });
  },
}));
