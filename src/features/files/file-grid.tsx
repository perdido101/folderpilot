import { Check, Copy, EyeOff, Monitor, Moon, Trash2, Waves, Minimize2 } from "lucide-react";
import type { FileFlag, FileRecord } from "@/lib/db";
import { setDragFiles } from "@/lib/dnd";
import { cn } from "@/lib/utils";
import { useAnalysis } from "@/stores/analysis";
import { Thumbnail } from "./thumbnail";
import type { ItemHandlers } from "./file-browser";

interface Props extends ItemHandlers {
  files: FileRecord[];
  selected: ReadonlySet<number>;
  focusId: number | null;
  accessKey: number;
}

export const FLAG_ICONS: Record<FileFlag, { icon: typeof Copy; label: string }> = {
  duplicate: { icon: Copy, label: "Exact duplicate" },
  near_duplicate: { icon: Copy, label: "Near-duplicate" },
  blurry: { icon: Waves, label: "Blurry" },
  dark: { icon: Moon, label: "Dark" },
  tiny: { icon: Minimize2, label: "Tiny" },
  screenshot: { icon: Monitor, label: "Screenshot" },
  suggested_delete: { icon: Trash2, label: "Suggested for deletion" },
};

export function FileGrid({ files, selected, focusId, accessKey, onItemClick, onItemDoubleClick }: Props) {
  const inFlight = useAnalysis((s) => s.inFlight);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-4" role="listbox" aria-multiselectable>
      {files.map((file) => {
        const isSelected = selected.has(file.id);
        const working = inFlight.has(file.id);
        return (
          <div
            key={file.id}
            id={`file-${file.id}`}
            role="option"
            aria-selected={isSelected}
            draggable
            onDragStart={(e) => setDragFiles(e, isSelected ? [...selected] : [file.id])}
            onClick={(e) => onItemClick(file.id, e)}
            onDoubleClick={() => onItemDoubleClick(file.id)}
            className={cn(
              "group relative cursor-default select-none overflow-hidden rounded-lg border bg-surface p-2 transition-colors duration-200 [content-visibility:auto] [contain-intrinsic-size:auto_220px]",
              isSelected ? "border-accent bg-accent-soft" : "hover:bg-surface-2",
              focusId === file.id && "ring-2 ring-accent/50",
              file.status === "needs_review" && !isSelected && "border-warning/50",
            )}
          >
            <Thumbnail file={file} accessKey={accessKey} />
            <p className="mt-2 truncate text-xs font-medium" title={file.path}>
              {file.name}
            </p>
            <div className="mt-1 flex h-4 items-center gap-1">
              {file.category ? (
                <span className="truncate rounded bg-surface-2 px-1.5 text-[10px] text-muted" title={file.caption}>
                  {file.category}
                </span>
              ) : (
                <span className="text-[10px] text-muted/60">{file.analyzedLocally ? "" : "…"}</span>
              )}
              <span className="ml-auto flex gap-0.5">
                {file.flags.map((f) => {
                  const { icon: Icon, label } = FLAG_ICONS[f];
                  return <Icon key={f} className={cn("size-3", f === "suggested_delete" ? "text-danger" : "text-warning")} aria-label={label} />;
                })}
                {file.status === "needs_review" && <EyeOff className="size-3 text-warning" aria-label="Needs review" />}
              </span>
            </div>
            {isSelected && (
              <span className="absolute left-3 top-3 rounded-full bg-accent p-0.5 text-accent-foreground">
                <Check className="size-3" />
              </span>
            )}
            {working && <div className="fp-shimmer pointer-events-none absolute inset-0" aria-label="AI is analyzing" />}
          </div>
        );
      })}
    </div>
  );
}
