import { useLiveQuery } from "dexie-react-hooks";
import { ExternalLink, FolderOpen, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { undoBatch } from "@/lib/actions/engine";
import { pickDirectory } from "@/lib/fs-access";
import { cn } from "@/lib/utils";
import { AgentChat } from "@/components/layout/agent-panel";
import { useFolderDrop } from "@/features/intake/use-folder-drop";
import { useActiveRoot } from "@/hooks/use-active-root";
import { useIndexing } from "@/stores/indexing";
import { toast } from "@/stores/toasts";

/**
 * Mini mode (~400×520): drop zone, prompt box, plan cards, last actions with Undo, "Open full app".
 * Standalone route with no app shell, so it can become the Tauri tray popup later.
 */
export function MiniPage() {
  const root = useActiveRoot();
  const { status, progress, connectFolder } = useIndexing();
  const { dragging, bind } = useFolderDrop((h) => void connectFolder(h), (m) => toast(m, "error"));
  const recent = useLiveQuery(async () => {
    if (!root) return [];
    const entries = await db.audit.where("rootId").equals(root.id).reverse().limit(200).toArray();
    const batches = new Map<string, { batchId: string; reason: string; count: number; undone: boolean; at: number }>();
    for (const e of entries) {
      if (e.action === "undo") continue;
      const b = batches.get(e.batchId) ?? { batchId: e.batchId, reason: e.reason ?? e.action, count: 0, undone: true, at: e.at };
      b.count++;
      b.undone &&= e.undone;
      batches.set(e.batchId, b);
    }
    return [...batches.values()].slice(0, 3);
  }, [root?.id]);

  return (
    <div {...bind} className={cn("flex h-full flex-col bg-surface", dragging && "bg-accent-soft")}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-5" />
        <span className="truncate text-sm font-semibold">{root ? root.name : "FolderPilot"}</span>
        <a href={import.meta.env.BASE_URL} target="folderpilot-main" className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline">
          Open full app <ExternalLink className="size-3" />
        </a>
      </header>
      {!root || status === "indexing" ? (
        <div className="m-3 flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 text-center">
          <FolderOpen className="size-8 text-accent" />
          <p className="text-sm font-medium">{status === "indexing" ? `Indexing… ${progress.scanned} files` : "Drop a folder here"}</p>
          {status !== "indexing" && (
            <Button
              size="sm"
              onClick={async () => {
                const h = await pickDirectory();
                if (h) await connectFolder(h);
              }}
            >
              Choose folder
            </Button>
          )}
        </div>
      ) : (
        <AgentChat compact />
      )}
      {recent && recent.length > 0 && (
        <footer className="shrink-0 space-y-1 border-t p-2">
          <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted">Last actions</p>
          {recent.map((b) => (
            <div key={b.batchId} className="flex items-center gap-2 px-1 text-xs">
              <span className={cn("min-w-0 flex-1 truncate", b.undone && "text-muted line-through")}>
                {b.reason} · {b.count}
              </span>
              {!b.undone && (
                <button
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                  onClick={async () => {
                    const r = await undoBatch(b.batchId);
                    toast(r.failed ? `Couldn't undo: ${r.errors[0]}` : `Undid ${r.undone}`, r.failed ? "error" : "default");
                  }}
                >
                  <Undo2 className="size-3" /> Undo
                </button>
              )}
            </div>
          ))}
        </footer>
      )}
    </div>
  );
}
