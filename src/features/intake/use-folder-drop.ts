import { useRef, useState, type DragEvent } from "react";
import { directoryHandlesFromDrop } from "@/lib/fs-access";

/** Drag-and-drop of folders from Explorer/Finder. Calls onFolder with the first dropped directory. */
export function useFolderDrop(onFolder: (handle: FileSystemDirectoryHandle) => void, onError: (message: string) => void) {
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
      const first = e.dataTransfer.items[0];
      if (!first || typeof first.getAsFileSystemHandle !== "function") {
        onError("This browser can't open dropped folders. Use Chrome or Edge, or click “Choose folder”.");
        return;
      }
      // Read handles synchronously within the event, then await.
      directoryHandlesFromDrop(e.dataTransfer).then(
        (dirs) => {
          const dir = dirs[0];
          if (dir) onFolder(dir);
          else onError("That looks like a file. Drop a folder instead.");
        },
        () => onError("Couldn't open the dropped folder."),
      );
    },
  };

  return { dragging, bind };
}
