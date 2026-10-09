import { create } from "zustand";
import { indexRoot, upsertRoot, type IndexProgress } from "@/lib/indexer";
import { ensureReadWrite } from "@/lib/fs-access";
import { registerRootHandle } from "@/lib/file-access-cache";
import { runLocalAnalysis } from "@/lib/analysis/runner";
import { runAIAnalysis } from "@/lib/ai/pipeline";
import { getSettings } from "@/lib/settings";
import { useUI } from "./ui";

type Status = "idle" | "indexing" | "done" | "cancelled" | "error";

interface IndexingState {
  status: Status;
  rootName: string;
  progress: IndexProgress;
  error: string | null;
  controller: AbortController | null;
  connectFolder: (handle: FileSystemDirectoryHandle) => Promise<void>;
  cancel: () => void;
  dismiss: () => void;
}

const EMPTY: IndexProgress = { scanned: 0, dirs: 0, currentPath: "" };

export const useIndexing = create<IndexingState>()((set, get) => ({
  status: "idle",
  rootName: "",
  progress: EMPTY,
  error: null,
  controller: null,

  connectFolder: async (handle) => {
    if (get().status === "indexing") return;
    if (!(await ensureReadWrite(handle))) {
      set({ status: "error", error: "FolderPilot needs read & write access to organize this folder." });
      return;
    }
    const controller = new AbortController();
    set({ status: "indexing", rootName: handle.name, progress: EMPTY, error: null, controller });
    try {
      const rootId = await upsertRoot(handle);
      registerRootHandle(rootId, handle);
      useUI.getState().setActiveRootId(rootId);
      await indexRoot(rootId, handle, (progress) => set({ progress }), controller.signal);
      set({ status: controller.signal.aborted ? "cancelled" : "done", controller: null });
      if (!controller.signal.aborted) void analyzeAfterIndex(rootId);
    } catch (err) {
      set({ status: "error", error: err instanceof Error ? err.message : String(err), controller: null });
    }
  },

  cancel: () => get().controller?.abort(),
  dismiss: () => set({ status: "idle", error: null }),
}));

/** Local analysis is free, so it always runs; AI analysis only when the user turned it on. */
async function analyzeAfterIndex(rootId: number) {
  await runLocalAnalysis(rootId);
  const settings = await getSettings();
  if (settings.autoAnalyzeWithAI && settings.ai.provider !== "none") await runAIAnalysis(rootId).catch(() => undefined);
}
