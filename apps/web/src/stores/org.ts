import { create } from "zustand";

/** The signed-in organization, readable outside React (e.g. by the AI pipeline for FolderPilot AI). */
export const useOrgStore = create<{ activeOrgId: string | null; setActiveOrgId: (id: string | null) => void }>()((set) => ({
  activeOrgId: null,
  setActiveOrgId: (activeOrgId) => set({ activeOrgId }),
}));
