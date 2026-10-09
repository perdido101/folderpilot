/** Chrome/Edge desktop support the File System Access API we rely on. */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function ensureReadWrite(handle: FileSystemHandle): Promise<boolean> {
  const opts = { mode: "readwrite" } as const;
  if ((await handle.queryPermission?.(opts)) === "granted") return true;
  return (await handle.requestPermission?.(opts)) === "granted";
}

export async function hasReadWrite(handle: FileSystemHandle): Promise<boolean> {
  return (await handle.queryPermission?.({ mode: "readwrite" })) === "granted";
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!window.showDirectoryPicker) return null;
  try {
    return await window.showDirectoryPicker({ id: "folderpilot-root", mode: "readwrite" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null; // user cancelled
    throw err;
  }
}

/**
 * Must be called synchronously inside the drop handler: DataTransfer items are only
 * readable during the event, so we grab the handle promises before awaiting anything.
 */
export function directoryHandlesFromDrop(dt: DataTransfer): Promise<FileSystemDirectoryHandle[]> {
  const pending = Array.from(dt.items)
    .filter((item) => item.kind === "file" && typeof item.getAsFileSystemHandle === "function")
    .map((item) => item.getAsFileSystemHandle!());
  return Promise.all(pending).then((handles) =>
    handles.filter((h): h is FileSystemDirectoryHandle => h?.kind === "directory"),
  );
}

/** Resolve a "/"-separated relative path to a file handle under the root. */
export async function resolveFile(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
  const parts = path.split("/");
  const fileName = parts.pop();
  if (!fileName) throw new Error(`Invalid path: ${path}`);
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  return dir.getFileHandle(fileName);
}
