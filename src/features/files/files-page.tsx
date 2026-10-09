import { useEffect, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { LayoutGrid, Lock, RefreshCw, Rows3, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { ensureReadWrite, hasReadWrite } from "@/lib/fs-access";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DropZone } from "@/features/intake/drop-zone";
import { IndexProgressCard } from "@/features/intake/index-progress";
import { useFolderDrop } from "@/features/intake/use-folder-drop";
import { useIndexing } from "@/stores/indexing";
import { useUI, type ViewMode } from "@/stores/ui";
import { FileBrowser } from "./file-browser";

export function FilesPage() {
  const roots = useLiveQuery(() => db.roots.orderBy("addedAt").toArray());
  const activeRootId = useUI((s) => s.activeRootId);
  const { status, error, connectFolder, dismiss } = useIndexing();
  const root = roots?.find((r) => r.id === activeRootId) ?? roots?.at(-1);
  const files = useLiveQuery(() => (root ? db.files.where("rootId").equals(root.id).toArray() : []), [root?.id]);

  // Access to a folder doesn't survive a restart (by design); track it so we can offer "Allow access".
  const [access, setAccess] = useState<"unknown" | "granted" | "prompt">("unknown");
  const [accessKey, setAccessKey] = useState(0);
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    void hasReadWrite(root.handle).then((ok) => !cancelled && setAccess(ok ? "granted" : "prompt"));
    return () => {
      cancelled = true;
    };
  }, [root, status]);

  const [dropError, setDropError] = useState<string | null>(null);
  const { dragging, bind } = useFolderDrop((h) => void connectFolder(h), setDropError);

  if (roots === undefined) return null; // first Dexie read
  if (status === "indexing") return <IndexProgressCard />;
  if (!root) return <DropZone />;

  const allowAccess = async () => {
    if (await ensureReadWrite(root.handle)) {
      setAccess("granted");
      setAccessKey((k) => k + 1);
    }
  };
  const totalSize = files?.reduce((sum, f) => sum + f.size, 0) ?? 0;
  const message = error ?? dropError;

  return (
    <div {...bind} className="relative flex h-full flex-col">
      <Toolbar
        title={root.name}
        subtitle={files ? `${files.length.toLocaleString()} files · ${formatBytes(totalSize)}` : "…"}
        onRescan={async () => {
          if (await ensureReadWrite(root.handle)) void connectFolder(root.handle);
        }}
      />
      {access === "prompt" && (
        <Banner tone="accent" icon={<Lock className="size-4" />}>
          Allow access to “{root.name}” again to see previews and rescan.
          <Button size="sm" className="ml-auto" onClick={allowAccess}>
            Allow access
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
      <FileBrowser files={files ?? []} accessKey={accessKey} />
      {dragging && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent-soft/90 text-lg font-medium text-accent">
          Drop to open this folder
        </div>
      )}
    </div>
  );
}

function Toolbar({ title, subtitle, onRescan }: { title: string; subtitle: string; onRescan: () => void }) {
  const viewMode = useUI((s) => s.viewMode);
  const setViewMode = useUI((s) => s.setViewMode);
  const views: { mode: ViewMode; label: string; icon: typeof LayoutGrid }[] = [
    { mode: "grid", label: "Grid", icon: LayoutGrid },
    { mode: "table", label: "Table", icon: Rows3 },
  ];

  return (
    <div className="flex items-center gap-3 border-b px-4 py-3">
      <div className="min-w-0">
        <h1 className="truncate font-semibold">{title}</h1>
        <p className="text-xs text-muted">{subtitle}</p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRescan}>
          <RefreshCw />
          Rescan
        </Button>
        <div className="flex rounded-lg border bg-surface p-0.5" role="group" aria-label="View">
          {views.map(({ mode, label, icon: Icon }) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              aria-pressed={viewMode === mode}
              title={label}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
                viewMode === mode ? "bg-accent-soft font-medium text-accent" : "text-muted hover:text-text",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Banner({ tone, icon, children }: { tone: "accent" | "warning" | "danger"; icon?: ReactNode; children: ReactNode }) {
  const tones = {
    accent: "bg-accent-soft text-accent",
    warning: "bg-warning/10 text-warning",
    danger: "bg-danger/10 text-danger",
  };
  return <div className={cn("flex items-center gap-2 border-b px-4 py-2 text-sm", tones[tone])}>{icon}{children}</div>;
}
