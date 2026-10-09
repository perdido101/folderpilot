import { NavLink } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Copy, Files, FolderOpen, FolderPlus, Inbox, ScrollText, Settings, Shapes, Trash2, Workflow } from "lucide-react";
import { db } from "@/lib/db";
import { pickDirectory } from "@/lib/fs-access";
import { cn } from "@/lib/utils";
import { useIndexing } from "@/stores/indexing";
import { useUI } from "@/stores/ui";

export const NAV = [
  { to: "/review", label: "Needs Review", icon: Inbox },
  { to: "/", label: "All Files", icon: Files },
  { to: "/categories", label: "Categories", icon: Shapes },
  { to: "/rules", label: "Rules", icon: Workflow },
  { to: "/duplicates", label: "Duplicates & Bad Files", icon: Copy },
  { to: "/audit", label: "Audit Log", icon: ScrollText },
  { to: "/trash", label: "Trash", icon: Trash2 },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function Sidebar() {
  const needsReview = useLiveQuery(() => db.files.where("status").equals("needs_review").count(), [], 0);
  const roots = useLiveQuery(() => db.roots.orderBy("addedAt").toArray(), [], []);
  const activeRootId = useUI((s) => s.activeRootId);
  const setActiveRootId = useUI((s) => s.setActiveRootId);
  const connectFolder = useIndexing((s) => s.connectFolder);

  const addFolder = async () => {
    const handle = await pickDirectory();
    if (handle) await connectFolder(handle);
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-surface">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <img src="/favicon.svg" alt="" className="size-6" />
        <span className="font-semibold tracking-tight">FolderPilot</span>
      </div>

      <nav className="flex flex-col gap-0.5 p-2" aria-label="Sections">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                isActive ? "bg-accent-soft font-medium text-accent" : "text-text hover:bg-surface-2",
              )
            }
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{label}</span>
            {to === "/review" && needsReview > 0 && (
              <span className="ml-auto rounded-full bg-warning/10 px-2 text-xs font-medium text-warning">{needsReview}</span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-2 flex min-h-0 flex-1 flex-col border-t p-2">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Folders</span>
          <button onClick={addFolder} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-text" aria-label="Add folder" title="Add folder">
            <FolderPlus className="size-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {roots.length === 0 && <p className="px-3 text-xs text-muted">No folders yet</p>}
          {roots.map((root) => (
            <button
              key={root.id}
              onClick={() => setActiveRootId(root.id)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-2",
                root.id === activeRootId && "bg-surface-2 font-medium",
              )}
            >
              <FolderOpen className="size-4 shrink-0 text-muted" />
              <span className="truncate">{root.name}</span>
              {root.fileCount !== undefined && <span className="ml-auto text-xs tabular-nums text-muted">{root.fileCount}</span>}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
