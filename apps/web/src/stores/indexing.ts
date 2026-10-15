import { create } from "zustand";
import { indexRoot, upsertReadOnlyRoot, upsertRoot, type IndexProgress } from "@/lib/indexer";
import type { FolderSource } from "@/lib/folder-source";
import { ensureReadWrite } from "@/lib/fs-access";
import { registerMemoryFiles, registerRootHandle } from "@/lib/file-access-cache";
import { runLocalAnalysis } from "@/lib/analysis/runner";
import { runAIAnalysis } from "@/lib/ai/pipeline";
import { runRulesOnNewFiles } from "@/lib/rules/device-runner";
import { announceRuleOutcomes } from "@/features/rules/announce";
import { navigateTo } from "@/lib/navigation";
import { getSettings } from "@/lib/settings";
import i18n from "@/i18n";
import { useUI } from "./ui";

type Status = "idle" | "indexing" | "done" | "cancelled" | "error";

interface IndexingState {
  status: Status;
  rootName: string;
  progress: IndexProgress;
  error: string | null;
  controller: AbortController | null;
  /** Open (or rescan) a folder from a picker/drop source, or a directory handle. */
  connectFolder: (source: FolderSource | FileSystemDirectoryHandle) => Promise<void>;
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

  connectFolder: async (input) => {
    if (get().status === "indexing") return;
    const source: FolderSource = input.kind === "directory" ? { kind: "handle", name: input.name, handle: input } : input;
    if (source.kind === "handle" && !(await ensureReadWrite(source.handle))) {
      set({ status: "error", error: i18n.t("actions:errors.needsReadWrite") });
      return;
    }
    const controller = new AbortController();
    set({ status: "indexing", rootName: source.name, progress: EMPTY, error: null, controller });
    try {
      let rootId: number;
      if (source.kind === "handle") {
        rootId = await upsertRoot(source.handle);
        registerRootHandle(rootId, source.handle);
      } else {
        rootId = await upsertReadOnlyRoot(source.name);
        registerMemoryFiles(rootId, source.files);
      }
      useUI.getState().setActiveRootId(rootId);
      await indexRoot(rootId, source.kind === "handle" ? source.handle : source.files, (progress) => set({ progress }), controller.signal);
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
  // New/changed files are ready: run the rules (auto rules apply, suggest rules wait in Pending Approvals).
  const outcomes = await runRulesOnNewFiles(rootId).catch(() => []);
  announceRuleOutcomes(
    outcomes.map((o) => ({ mode: o.mode, files: o.files, done: o.result?.done, failed: o.result ? o.result.failed + o.result.conflicted : 0, error: o.error })),
    { quietWhenNothing: true, openApprovals: () => navigateTo("/approvals") },
  );
}
