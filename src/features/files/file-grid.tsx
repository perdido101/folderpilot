import { Check } from "lucide-react";
import type { FileRecord } from "@/lib/db";
import { cn } from "@/lib/utils";
import { Thumbnail } from "./thumbnail";
import type { ItemHandlers } from "./file-browser";

interface Props extends ItemHandlers {
  files: FileRecord[];
  selected: ReadonlySet<number>;
  focusId: number | null;
  accessKey: number;
}

export function FileGrid({ files, selected, focusId, accessKey, onItemClick, onItemDoubleClick }: Props) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-4" role="listbox" aria-multiselectable>
      {files.map((file) => {
        const isSelected = selected.has(file.id);
        return (
          <div
            key={file.id}
            id={`file-${file.id}`}
            role="option"
            aria-selected={isSelected}
            onClick={(e) => onItemClick(file.id, e)}
            onDoubleClick={() => onItemDoubleClick(file.id)}
            className={cn(
              "group relative cursor-default select-none rounded-lg border bg-surface p-2 transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_200px]",
              isSelected ? "border-accent bg-accent-soft" : "hover:bg-surface-2",
              focusId === file.id && "ring-2 ring-accent/50",
            )}
          >
            <Thumbnail file={file} accessKey={accessKey} />
            <p className="mt-2 truncate text-xs font-medium" title={file.path}>
              {file.name}
            </p>
            {isSelected && (
              <span className="absolute left-3 top-3 rounded-full bg-accent p-0.5 text-accent-foreground">
                <Check className="size-3" />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
