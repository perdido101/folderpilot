import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark" | "system";
export type ViewMode = "grid" | "table";

interface UIState {
  theme: Theme;
  agentPanelOpen: boolean;
  viewMode: ViewMode;
  search: string;
  activeRootId: number | null;
  setTheme: (theme: Theme) => void;
  toggleAgentPanel: () => void;
  setViewMode: (mode: ViewMode) => void;
  setSearch: (search: string) => void;
  setActiveRootId: (id: number | null) => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      theme: "system",
      agentPanelOpen: true,
      viewMode: "grid",
      search: "",
      activeRootId: null,
      setTheme: (theme) => {
        // index.html reads this raw key before first paint.
        try {
          localStorage.setItem("fp-theme", theme);
        } catch {
          /* storage unavailable */
        }
        set({ theme });
      },
      toggleAgentPanel: () => set((s) => ({ agentPanelOpen: !s.agentPanelOpen })),
      setViewMode: (viewMode) => set({ viewMode }),
      setSearch: (search) => set({ search }),
      setActiveRootId: (activeRootId) => set({ activeRootId }),
    }),
    {
      name: "fp-ui",
      partialize: (s) => ({ theme: s.theme, agentPanelOpen: s.agentPanelOpen, viewMode: s.viewMode, activeRootId: s.activeRootId }),
    },
  ),
);
