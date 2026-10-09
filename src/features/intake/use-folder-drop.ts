import { useRef, useState, type DragEvent } from "react";
import { folderFromDrop, type FolderSource } from "@/lib/folder-source";

/** Drag-and-drop of folders from Explorer/Finder. Calls onFolder with the first dropped directory. */
export function useFolderDrop(onFolder: (source: FolderSource) => void, onError: (message: string) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0); // dragenter/leave fire for every child element

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

  const bind = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      // Reads handles/entries synchronously within the event, then awaits.
      folderFromDrop(e.dataTransfer).then(
        (source) => {
          if (source) onFolder(source);
          else onError("That looks like a file. Drop a folder instead.");
        },
        () => onError("Couldn't open the dropped folder."),
      );
    },
  };

  return { dragging, bind };
}
