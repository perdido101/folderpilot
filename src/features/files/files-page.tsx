import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, LayoutGrid, Lock, RefreshCw, Rows3, Sparkles, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PromptDialog } from "@/components/prompt-dialog";
import type { FileRecord } from "@/lib/db";
import { ensureReadWrite, hasReadWrite } from "@/lib/fs-access";
import { hasMemoryFiles } from "@/lib/file-access-cache";
import { chooseFolder } from "@/lib/folder-source";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { createProvider } from "@/lib/ai";
import { runAIAnalysis } from "@/lib/ai/pipeline";
import { runLocalAnalysis } from "@/lib/analysis/runner";
import { proposeFolders, proposeRules, proposeSuggestedNames } from "@/lib/actions/organize";
import { keywordSearch, semanticSearch } from "@/lib/search";
import { useSettings } from "@/lib/settings";
import { DropZone } from "@/features/intake/drop-zone";
import { IndexProgressCard } from "@/features/intake/index-progress";
import { useFolderDrop } from "@/features/intake/use-folder-drop";
import { PlanDialog } from "@/features/plans/plan-card";
import { useActiveRoot, useRootFiles } from "@/hooks/use-active-root";
import { useAnalysis } from "@/stores/analysis";
import { useIndexing } from "@/stores/indexing";
import { toast } from "@/stores/toasts";
import { useUI, type ViewMode } from "@/stores/ui";
import { AnalysisStatus } from "./analysis-status";
import { FileBrowser } from "./file-browser";

type KindFilter = "all" | "images" | "docs" | "other";
const KIND_FILTERS: { key: KindFilter; label: string; test: (f: FileRecord) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "images", label: "Images", test: (f) => f.kind === "image" },
  { key: "docs", label: "Documents", test: (f) => f.kind === "document" || f.kind === "spreadsheet" },
  { key: "other", label: "Other", test: (f) => !["image", "document", "spreadsheet"].includes(f.kind) },
];

export function FilesPage() {
  const root = useActiveRoot();
  const { status, error, connectFolder, dismiss } = useIndexing();
  const files = useRootFiles(root?.id);
  const search = useUI((s) => s.search);
  const semantic = useUI((s) => s.semanticSearch);
  const setViewMode = useUI((s) => s.setViewMode);
  const settings = useSettings();
  const phase = useAnalysis((s) => s.phase);
  const [kind, setKind] = useState<KindFilter>("all");
  const [planId, setPlanId] = useState<number | null>(null);
  const [folderDialog, setFolderDialog] = useState(false);

  // Access to a folder doesn't survive a restart (by design); track it so we can offer "Allow access".
  const [access, setAccess] = useState<"unknown" | "granted" | "prompt">("unknown");
  const [accessKey, setAccessKey] = useState(0);
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    const check = root.handle ? hasReadWrite(root.handle) : Promise.resolve(hasMemoryFiles(root.id));
    void check.then((ok) => !cancelled && setAccess(ok ? "granted" : "prompt"));
    return () => {
      cancelled = true;
    };
  }, [root, status]);

  const [dropError, setDropError] = useState<string | null>(null);
  const { dragging, bind } = useFolderDrop((h) => void connectFolder(h), setDropError);

  // Search: keyword always; semantic when the provider supports embeddings and the toggle is on.
  const [semanticHits, setSemanticHits] = useState<FileRecord[] | null>(null);
  const liveFiles = useMemo(() => (files ?? []).filter((f) => f.status !== "trashed"), [files]);
  useEffect(() => {
    setSemanticHits(null);
    const provider = createProvider(settings.ai);
    if (!semantic || !search.trim() || !root || !provider?.embed) return;
    let cancelled = false;
    const t = setTimeout(() => {
      semanticSearch(root.id, liveFiles, search, provider)
        .then((r) => !cancelled && setSemanticHits(r.map((x) => x.file)))
        .catch((err: unknown) => toast(`Semantic search failed: ${err instanceof Error ? err.message : String(err)}`, "error"));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [semantic, search, root, liveFiles, settings.ai]);

  const kindTest = KIND_FILTERS.find((k) => k.key === kind)!.test;
  const shown = useMemo(() => {
    const base = search.trim() ? (semanticHits ?? keywordSearch(liveFiles, search).map((r) => r.file)) : liveFiles;
    return base.filter(kindTest);
  }, [liveFiles, search, semanticHits, kindTest]);

  if (root === undefined) return null; // first Dexie read
  if (status === "indexing") return <IndexProgressCard />;
  if (!root) return <DropZone />;

  // Read-only folders have no handle to re-authorize: the user picks the folder again.
  const reopen = async () => {
    const source = await chooseFolder();
    if (source) await connectFolder(source);
  };
  const rescan = async () => {
    if (!root.handle) return reopen();
    if (await ensureReadWrite(root.handle)) void connectFolder(root.handle);
  };
  const allowAccess = async () => {
    if (!root.handle) return reopen();
    if (await ensureReadWrite(root.handle)) {
      setAccess("granted");
      setAccessKey((k) => k + 1);
      void runLocalAnalysis(root.id);
    }
  };
  const totalSize = liveFiles.reduce((sum, f) => sum + f.size, 0);
  const message = error ?? dropError;
  const aiReady = settings.ai.provider !== "none";
  const toAnalyze = liveFiles.filter((f) => f.status === "indexed" && f.analyzedLocally).length;

  const analyzeAI = async () => {
    try {
      const r = await runAIAnalysis(root.id);
      toast(`AI analyzed ${r.analyzed + r.review} files${r.review ? ` · ${r.review} need review` : ""}${r.failed ? ` · ${r.failed} failed` : ""}`, r.failed ? "error" : "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  };
  const propose = async (p: Promise<number | null>) => {
    const id = await p;
    if (id === null) toast("Nothing to change.");
    else setPlanId(id);
  };

  return (
    <div {...bind} className="relative flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate font-semibold">
            {root.name}
            {root.readOnly && (
              <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning" title="Opened without the File System Access API: files can't be moved or renamed">
                Read-only
              </span>
            )}
          </h1>
          <p className="text-xs text-muted">{files ? `${liveFiles.length.toLocaleString()} files · ${formatBytes(totalSize)}` : "…"}</p>
        </div>
        <AnalysisStatus />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void rescan()} title="Look for new, changed and removed files">
            <RefreshCw />
            Rescan
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={phase !== "idle"}
            onClick={aiReady ? analyzeAI : () => toast("Connect an AI in Settings to categorize, caption and name files.")}
            title={aiReady ? `${toAnalyze} files not analyzed by AI yet` : "Connect an AI in Settings"}
          >
            <Sparkles />
            Analyze with AI{toAnalyze ? ` (${toAnalyze})` : ""}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Wand2 />
                Organize
                <ChevronDown className="opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void propose(proposeRules(root.id))}>Run all rules…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void propose(proposeSuggestedNames(root.id, liveFiles))}>Rename to AI-suggested names…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setFolderDialog(true)}>Move into folders by pattern…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void propose(proposeFolders(root.id, liveFiles.filter((f) => f.category), "{category}"))}>Folder per category…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void propose(proposeFolders(root.id, liveFiles.filter((f) => f.client), "Clients/{client}"))}>Folder per client…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ViewToggle onChange={setViewMode} />
        </div>
      </div>
      <div className="flex items-center gap-1 border-b px-4 py-1.5">
        {KIND_FILTERS.map((k) => (
          <button
            key={k.key}
            onClick={() => setKind(k.key)}
            className={cn("rounded-full px-3 py-1 text-xs transition-colors", kind === k.key ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-text")}
          >
            {k.label}
          </button>
        ))}
        {search.trim() && (
          <span className="ml-auto text-xs text-muted">
            {shown.length} result{shown.length === 1 ? "" : "s"} for “{search}”{semanticHits ? " · semantic" : ""}
          </span>
        )}
      </div>
      {access === "prompt" && (
        <Banner tone="accent" icon={<Lock className="size-4" />}>
          {root.readOnly ? `Choose “${root.name}” again to see previews and analyze it (read-only folders aren't kept between visits).` : `Allow access to “${root.name}” again to see previews, analyze and organize.`}
          <Button size="sm" className="ml-auto" onClick={allowAccess}>
            {root.readOnly ? "Choose folder" : "Allow access"}
          </Button>
        </Banner>
      )}
      {message && (
        <Banner tone="danger">
          {message}
          <button
            className="ml-auto"
            onClick={() => {
              dismiss();
              setDropError(null);
            }}
            aria-label="Dismiss"
          >
            <X className="size-4" />
          </button>
        </Banner>
      )}
      {status === "cancelled" && <Banner tone="warning">Indexing was cancelled — the list is incomplete. Click Rescan to finish.</Banner>}
      <FileBrowser
        rootId={root.id}
        files={shown}
        allFiles={liveFiles}
        ranked={Boolean(search.trim())}
        accessKey={accessKey}
        emptyText={search.trim() ? `No files match “${search}”.` : kind !== "all" ? "No files of this type." : "This folder has no files."}
      />
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/90 text-lg font-medium text-accent">
          Drop to open this folder
        </div>
      )}
      <PlanDialog planId={planId} onClose={() => setPlanId(null)} />
      <PromptDialog
        open={folderDialog}
        title="Move into folders by pattern"
        description="Every file is moved to the folder the pattern gives. You'll review the plan before anything changes."
        label="Folder pattern"
        initial="{category}/{year}"
        confirm="Preview plan"
        onSubmit={(v) => void propose(proposeFolders(root.id, liveFiles, v))}
        onClose={() => setFolderDialog(false)}
      />
    </div>
  );
}

function ViewToggle({ onChange }: { onChange: (m: ViewMode) => void }) {
  const viewMode = useUI((s) => s.viewMode);
  const views: { mode: ViewMode; label: string; icon: typeof LayoutGrid }[] = [
    { mode: "grid", label: "Grid", icon: LayoutGrid },
    { mode: "table", label: "Table", icon: Rows3 },
  ];
  return (
    <div className="flex rounded-lg border bg-surface p-0.5" role="group" aria-label="View">
      {views.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          aria-pressed={viewMode === mode}
          title={label}
          className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors", viewMode === mode ? "bg-accent-soft font-medium text-accent" : "text-muted hover:text-text")}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

export function Banner({ tone, icon, children }: { tone: "accent" | "warning" | "danger"; icon?: ReactNode; children: ReactNode }) {
  const tones = {
    accent: "bg-accent-soft text-accent",
    warning: "bg-warning/10 text-warning",
    danger: "bg-danger/10 text-danger",
  };
  return (
    <div className={cn("flex items-center gap-2 border-b px-4 py-2 text-sm", tones[tone])}>
      {icon}
      {children}
    </div>
  );
}
