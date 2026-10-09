import { RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { restoreFiles } from "@/lib/actions/user-actions";
import { formatBytes } from "@/lib/format";
import { FileIcon } from "@/features/files/file-icon";
import { useActiveRoot, useRootFiles } from "@/hooks/use-active-root";
import { PlaceholderPage } from "@/pages/placeholder-page";

/** Trashed files live in the hidden .folderpilot-trash folder. FolderPilot never deletes permanently. */
export function TrashPage() {
  const root = useActiveRoot();
  const trashed = (useRootFiles(root?.id) ?? []).filter((f) => f.status === "trashed");
  if (!root) return <PlaceholderPage icon={Trash2} title="Trash" description="Open a folder first." />;
  if (!trashed.length) return <PlaceholderPage icon={Trash2} title="Trash is empty" description="Trashed files are moved to a hidden .folderpilot-trash folder inside your folder and can always be restored." />;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div>
          <h1 className="font-semibold">Trash</h1>
          <p className="text-xs text-muted">
            {trashed.length} files · {formatBytes(trashed.reduce((s, f) => s + f.size, 0))} in <span className="font-mono">.folderpilot-trash</span>. To free space for good, empty that folder yourself in Explorer.
          </p>
        </div>
        <Button size="sm" className="ml-auto" onClick={() => void restoreFiles(root.id, trashed)}>
          <RotateCcw />
          Restore all
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <tbody>
            {trashed.map((f) => (
              <tr key={f.id} className="border-b">
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <FileIcon kind={f.kind} className="size-4" />
                    {f.name}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-xs text-muted">was {f.trashedFrom}</td>
                <td className="px-4 py-2 text-right text-xs text-muted">{formatBytes(f.size)}</td>
                <td className="px-4 py-2 text-right">
                  <Button size="sm" variant="outline" onClick={() => void restoreFiles(root.id, [f])}>
                    <RotateCcw />
                    Restore
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
