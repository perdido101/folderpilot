import { Check, Copy, EyeOff, Monitor, Moon, Trash2, Waves, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileFlag, FileRecord } from "@/lib/db";
import { setDragFiles } from "@/lib/dnd";
import { cn } from "@folderpilot/ui";
import { useAnalysis } from "@/stores/analysis";
import { Thumbnail } from "./thumbnail";
import type { ItemHandlers } from "./file-browser";

interface Props extends ItemHandlers {
  files: FileRecord[];
  selected: ReadonlySet<number>;
  focusId: number | null;
  accessKey: number;
}

/** Labels live in the `files` namespace under `flags.<flag>`. */
export const FLAG_ICONS: Record<FileFlag, typeof Copy> = {
  duplicate: Copy,
  near_duplicate: Copy,
  blurry: Waves,
  dark: Moon,
  tiny: Minimize2,
  screenshot: Monitor,
  suggested_delete: Trash2,
};

export function FileGrid({ files, selected, focusId, accessKey, onItemClick, onItemDoubleClick }: Props) {
  const { t } = useTranslation("files");
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
                  const Icon = FLAG_ICONS[f];
                  return <Icon key={f} className={cn("size-3", f === "suggested_delete" ? "text-danger" : "text-warning")} aria-label={t(`flags.${f}`)} />;
                })}
                {file.status === "needs_review" && <EyeOff className="size-3 text-warning" aria-label={t("grid.needsReview")} />}
              </span>
            </div>
            {isSelected && (
              <span className="absolute left-3 top-3 rounded-full bg-accent p-0.5 text-accent-foreground">
                <Check className="size-3" />
              </span>
            )}
            {working && <div className="fp-shimmer pointer-events-none absolute inset-0" aria-label={t("grid.analyzing")} />}
          </div>
        );
      })}
    </div>
  );
}
