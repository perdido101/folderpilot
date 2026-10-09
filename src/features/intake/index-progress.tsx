import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIndexing } from "@/stores/indexing";

export function IndexProgressCard() {
  const { rootName, progress, cancel } = useIndexing();
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-4 rounded-lg border bg-surface p-6" role="status" aria-live="polite">
        <div className="flex items-center gap-3">
          <Loader2 className="size-5 animate-spin text-accent" />
          <div className="min-w-0">
            <p className="font-medium">Indexing “{rootName}”</p>
            <p className="text-xs text-muted">Reading file names, sizes and dates. Nothing is changed on disk.</p>
          </div>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-1/3 animate-[fp-indeterminate_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
        </div>
        <div className="flex gap-6 text-sm">
          <span>
            <span className="font-semibold tabular-nums">{progress.scanned.toLocaleString()}</span> <span className="text-muted">files</span>
          </span>
          <span>
            <span className="font-semibold tabular-nums">{progress.dirs.toLocaleString()}</span> <span className="text-muted">folders</span>
          </span>
        </div>
        <p className="truncate font-mono text-xs text-muted" title={progress.currentPath}>
          {progress.currentPath || "…"}
        </p>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
