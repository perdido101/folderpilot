import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { FileRecord } from "@/lib/db";
import { useSelection } from "@/stores/selection";
import { useUI } from "@/stores/ui";
import { FileGrid } from "./file-grid";
import { FileTable } from "./file-table";
import { SelectionBar } from "./selection-bar";

export type SortKey = "name" | "path" | "kind" | "size" | "mtime" | "category" | "relevance";
export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}
export interface ItemHandlers {
  onItemClick: (id: number, e: MouseEvent) => void;
  onItemDoubleClick: (id: number) => void;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compare(a: FileRecord, b: FileRecord, key: SortKey): number {
  switch (key) {
    case "size":
    case "mtime":
      return a[key] - b[key];
    case "kind":
      return collator.compare(a.ext, b.ext) || collator.compare(a.name, b.name);
    case "category":
      return collator.compare(a.category ?? "~", b.category ?? "~") || collator.compare(a.name, b.name);
    case "relevance":
      return 0;
    default:
      return collator.compare(a[key], b[key]);
  }
}

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

interface BrowserProps {
  rootId: number;
  /** Files to show. When `ranked` is true they are already in relevance order (search results). */
  files: FileRecord[];
  /** Every file of the root, for folder suggestions. */
  allFiles?: FileRecord[];
  ranked?: boolean;
  accessKey: number;
  emptyText?: string;
}

export function FileBrowser({ rootId, files, allFiles, ranked = false, accessKey, emptyText = "This folder has no files." }: BrowserProps) {
  const viewMode = useUI((s) => s.viewMode);
  const [sort, setSort] = useState<SortState>({ key: "name", dir: "asc" });
  const { selected, focusId, quickLookId, click, selectAll, clear, setFocus, openQuickLook } = useSelection();
  const scrollRef = useRef<HTMLDivElement>(null);
  const effectiveSort: SortState = ranked && sort.key === "name" && sort.dir === "asc" ? { key: "relevance", dir: "asc" } : sort;

  const visible = useMemo(() => {
    if (effectiveSort.key === "relevance") return files;
    const sign = effectiveSort.dir === "asc" ? 1 : -1;
    return [...files].sort((a, b) => sign * compare(a, b, effectiveSort.key));
  }, [files, effectiveSort.key, effectiveSort.dir]);

  const ids = useMemo(() => visible.map((f) => f.id), [visible]);

  // Drop selection for files that are no longer listed (e.g. after a rescan or search).
  useEffect(() => {
    const present = new Set(ids);
    if ([...selected].some((id) => !present.has(id))) selectAll([...selected].filter((id) => present.has(id)));
  }, [ids, selected, selectAll]);

  const moveFocus = (delta: number, extend: boolean) => {
    const current = focusId === null ? -1 : ids.indexOf(focusId);
    const nextId = ids[Math.min(ids.length - 1, Math.max(0, current + delta))];
    if (nextId === undefined) return;
    click(nextId, ids, { shift: extend, toggle: false });
    document.getElementById(`file-${nextId}`)?.scrollIntoView({ block: "nearest" });
  };

  /** Number of tiles per grid row, measured from the DOM so Up/Down move by rows. */
  const gridColumns = () => {
    const grid = scrollRef.current?.querySelector('[role="listbox"]');
    if (!grid) return 1;
    return getComputedStyle(grid).gridTemplateColumns.split(" ").length;
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || quickLookId !== null || isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const row = viewMode === "grid" ? gridColumns() : 1;
      if (e.key === " " || e.key === "Enter") {
        const target = focusId ?? [...selected][0] ?? null;
        if (target !== null) openQuickLook(target, ids);
      } else if (mod && e.key.toLowerCase() === "a") {
        selectAll(ids);
      } else if (e.key === "Escape") {
        clear();
      } else if (viewMode === "grid" && e.key === "ArrowRight") {
        moveFocus(1, e.shiftKey);
      } else if (viewMode === "grid" && e.key === "ArrowLeft") {
        moveFocus(-1, e.shiftKey);
      } else if (e.key === "ArrowDown") {
        moveFocus(row, e.shiftKey);
      } else if (e.key === "ArrowUp") {
        moveFocus(-row, e.shiftKey);
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const handlers: ItemHandlers = {
    onItemClick: (id, e) => click(id, ids, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey }),
    onItemDoubleClick: (id) => {
      setFocus(id);
      openQuickLook(id, ids);
    },
  };

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "mtime" || key === "size" ? "desc" : "asc" }));

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto pb-20"
        onClick={(e) => e.target === e.currentTarget && clear()}
      >
        {visible.length === 0 ? (
          <p className="p-8 text-center text-muted">{emptyText}</p>
        ) : viewMode === "grid" ? (
          <FileGrid files={visible} selected={selected} focusId={focusId} accessKey={accessKey} {...handlers} />
        ) : (
          <FileTable files={visible} selected={selected} focusId={focusId} sort={effectiveSort} onSort={onSort} {...handlers} />
        )}
      </div>
      <SelectionBar rootId={rootId} files={visible.filter((f) => selected.has(f.id))} allFiles={allFiles ?? files} onClear={clear} />
    </div>
  );
}
