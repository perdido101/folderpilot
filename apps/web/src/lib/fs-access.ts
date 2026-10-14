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

/** Resolve a "/"-separated relative path to a file handle under the root. */
export async function resolveFile(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
  const parts = path.split("/");
  const fileName = parts.pop();
  if (!fileName) throw new Error(`Invalid path: ${path}`);
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  return dir.getFileHandle(fileName);
}
