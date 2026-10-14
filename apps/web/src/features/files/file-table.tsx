import { ArrowDown, ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileRecord } from "@/lib/db";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@folderpilot/ui";
import { FileIcon } from "./file-icon";
import { setDragFiles } from "@/lib/dnd";
import type { ItemHandlers, SortKey, SortState } from "./file-browser";

interface Props extends ItemHandlers {
  files: FileRecord[];
  selected: ReadonlySet<number>;
  focusId: number | null;
  sort: SortState;
  onSort: (key: SortKey) => void;
}

/** Column labels live in the `files` namespace under `table.columns.<key>`. */
const COLUMNS: { key: Exclude<SortKey, "relevance">; className?: string }[] = [
  { key: "name" },
  { key: "path" },
  { key: "category", className: "w-36" },
  { key: "kind", className: "w-20" },
  { key: "size", className: "w-24 text-right" },
  { key: "mtime", className: "w-44" },
];

function folderOf(path: string) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "/" : path.slice(0, i);
}

export function FileTable({ files, selected, focusId, sort, onSort, onItemClick, onItemDoubleClick }: Props) {
  const { t } = useTranslation("files");
  return (
    <table className="w-full table-fixed border-collapse text-sm" aria-multiselectable>
      <thead className="sticky top-0 z-10 bg-surface">
        <tr className="border-b">
          {COLUMNS.map((col) => (
            <th key={col.key} className={cn("px-4 py-2 text-left text-xs font-medium text-muted", col.className)}>
              <button onClick={() => onSort(col.key)} className="inline-flex items-center gap-1 hover:text-text">
                {t(`table.columns.${col.key}`)}
                {sort.key === col.key && (sort.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {files.map((file) => {
          const isSelected = selected.has(file.id);
          return (
            <tr
              key={file.id}
              id={`file-${file.id}`}
              aria-selected={isSelected}
              draggable
              onDragStart={(e) => setDragFiles(e, isSelected ? [...selected] : [file.id])}
              onClick={(e) => onItemClick(file.id, e)}
              onDoubleClick={() => onItemDoubleClick(file.id)}
              className={cn(
                "cursor-default select-none border-b transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_37px]",
                isSelected ? "bg-accent-soft" : "hover:bg-surface-2",
                focusId === file.id && "outline outline-2 -outline-offset-2 outline-accent/50",
              )}
            >
              <td className="px-4 py-2">
                <span className="flex items-center gap-2">
                  <FileIcon kind={file.kind} className="size-4" />
                  <span className="truncate" title={file.name}>
                    {file.name}
                  </span>
                </span>
              </td>
              <td className="truncate px-4 py-2 font-mono text-xs text-muted" title={folderOf(file.path)}>
                {folderOf(file.path)}
              </td>
              <td className="truncate px-4 py-2 text-muted" title={file.caption}>
                {file.category ?? ""}
                {file.flags.length > 0 && <span className="ml-1 text-warning">· {t("table.flag", { count: file.flags.length })}</span>}
              </td>
              <td className="px-4 py-2 text-muted">{file.ext ? file.ext.toUpperCase() : file.kind}</td>
              <td className="px-4 py-2 text-right tabular-nums text-muted">{formatBytes(file.size)}</td>
              <td className="px-4 py-2 tabular-nums text-muted">{formatDate(file.mtime)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
