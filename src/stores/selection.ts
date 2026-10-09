import { create } from "zustand";

interface SelectionState {
  selected: ReadonlySet<number>;
  /** Anchor for Shift-click range selection. */
  anchorId: number | null;
  /** Keyboard focus; Space opens quick-look on it. */
  focusId: number | null;
  quickLookId: number | null;
  click: (id: number, orderedIds: readonly number[], mods: { shift: boolean; toggle: boolean }) => void;
  selectAll: (ids: readonly number[]) => void;
  clear: () => void;
  setFocus: (id: number | null) => void;
  openQuickLook: (id: number | null) => void;
}

export const useSelection = create<SelectionState>()((set, get) => ({
  selected: new Set(),
  anchorId: null,
  focusId: null,
  quickLookId: null,

  click: (id, orderedIds, { shift, toggle }) => {
    const { selected, anchorId } = get();
    if (shift && anchorId !== null) {
      const a = orderedIds.indexOf(anchorId);
      const b = orderedIds.indexOf(id);
      if (a !== -1 && b !== -1) {
        const range = orderedIds.slice(Math.min(a, b), Math.max(a, b) + 1);
        const next = toggle ? new Set(selected) : new Set<number>();
        range.forEach((r) => next.add(r));
        set({ selected: next, focusId: id });
        return;
      }
    }
    if (toggle) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      set({ selected: next, anchorId: id, focusId: id });
      return;
    }
    set({ selected: new Set([id]), anchorId: id, focusId: id });
  },
  selectAll: (ids) => set({ selected: new Set(ids) }),
  clear: () => set({ selected: new Set(), anchorId: null }),
  setFocus: (focusId) => set({ focusId }),
  openQuickLook: (quickLookId) => set({ quickLookId }),
}));
