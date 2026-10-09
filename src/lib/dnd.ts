import type { DragEvent } from "react";

/** Files dragged inside the app (onto categories, into the chat). */
export const FILES_MIME = "application/x-folderpilot-files";

export function setDragFiles(e: DragEvent, ids: number[]) {
  e.dataTransfer.setData(FILES_MIME, JSON.stringify(ids));
  e.dataTransfer.effectAllowed = "move";
}

export function hasDragFiles(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(FILES_MIME);
}

export function getDragFiles(e: DragEvent): number[] {
  try {
    const v: unknown = JSON.parse(e.dataTransfer.getData(FILES_MIME));
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}
