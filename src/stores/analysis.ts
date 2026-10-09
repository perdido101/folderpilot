import { create } from "zustand";

export type AnalysisPhase = "idle" | "local" | "ai";

interface AnalysisState {
  phase: AnalysisPhase;
  done: number;
  total: number;
  /** File ids the AI is working on right now (for the shimmer). */
  inFlight: ReadonlySet<number>;
  lastError: string | null;
  set: (patch: Partial<Omit<AnalysisState, "set" | "markInFlight">>) => void;
  markInFlight: (id: number, on: boolean) => void;
}

export const useAnalysis = create<AnalysisState>()((set) => ({
  phase: "idle",
  done: 0,
  total: 0,
  inFlight: new Set(),
  lastError: null,
  set: (patch) => set(patch),
  markInFlight: (id, on) =>
    set((s) => {
      const next = new Set(s.inFlight);
      if (on) next.add(id);
      else next.delete(id);
      return { inFlight: next };
    }),
}));
