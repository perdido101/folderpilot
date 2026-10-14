import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark" | "system";
export type ViewMode = "grid" | "table";

interface UIState {
  theme: Theme;
  agentPanelOpen: boolean;
  viewMode: ViewMode;
  search: string;
  semanticSearch: boolean;
  activeRootId: number | null;
  /** A server space (Cloud/Connect/Private server) being viewed instead of a folder on this device. */
  activeServerSpaceId: string | null;
  /** Right panel tab. */
  rightTab: "agent" | "details";
  setRightTab: (tab: "agent" | "details") => void;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setTheme: (theme: Theme) => void;
  toggleAgentPanel: () => void;
  setViewMode: (mode: ViewMode) => void;
  setSearch: (search: string) => void;
  setSemanticSearch: (on: boolean) => void;
  setActiveRootId: (id: number | null) => void;
  setActiveServerSpaceId: (id: string | null) => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      theme: "system",
      agentPanelOpen: true,
      viewMode: "grid",
      search: "",
      semanticSearch: false,
      activeRootId: null,
      activeServerSpaceId: null,
      rightTab: "agent",
      setRightTab: (rightTab) => set({ rightTab }),
      paletteOpen: false,
      shortcutsOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
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
      setSemanticSearch: (semanticSearch) => set({ semanticSearch }),
      setActiveRootId: (activeRootId) => set({ activeRootId, activeServerSpaceId: null }),
      setActiveServerSpaceId: (activeServerSpaceId) => set({ activeServerSpaceId }),
    }),
    {
      name: "fp-ui",
      partialize: (s) => ({ theme: s.theme, agentPanelOpen: s.agentPanelOpen, viewMode: s.viewMode, activeRootId: s.activeRootId, activeServerSpaceId: s.activeServerSpaceId, semanticSearch: s.semanticSearch, rightTab: s.rightTab }),
    },
  ),
);
