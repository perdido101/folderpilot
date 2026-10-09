import { db, type FileRecord } from "./db";
import { ensureReadWrite, hasReadWrite, resolveFile } from "./fs-access";

const rootHandles = new Map<number, FileSystemDirectoryHandle>();
/** Files of read-only folders, kept for this session only (they are never copied into storage). */
const memoryRoots = new Map<number, Map<string, File>>();

export function registerMemoryFiles(rootId: number, files: Map<string, File>) {
  memoryRoots.set(rootId, files);
}

/** True when a read-only folder's files are available in this session. */
export function hasMemoryFiles(rootId: number): boolean {
  return memoryRoots.has(rootId);
}

export class ReadOnlyFolderError extends Error {
  constructor(name: string) {
    super(`“${name}” was opened read-only, so files can't be moved or renamed. Open FolderPilot in Chrome or Edge (or enable File System Access in Brave) to organize files.`);
  }
}

/** Lets tests (and freshly connected folders) provide the live handle directly. */
export function registerRootHandle(rootId: number, handle: FileSystemDirectoryHandle) {
  rootHandles.set(rootId, handle);
}

export async function rootHandle(rootId: number): Promise<FileSystemDirectoryHandle | null> {
  let handle = rootHandles.get(rootId);
  if (!handle) {
    handle = (await db.roots.get(rootId))?.handle;
    if (!handle) return null;
    rootHandles.set(rootId, handle);
  }
  return handle;
}

/** Root handle with read/write access, prompting if needed (call from a user gesture). */
export async function writableRoot(rootId: number): Promise<FileSystemDirectoryHandle> {
  const handle = await rootHandle(rootId);
  if (!handle) {
    const root = await db.roots.get(rootId);
    if (root?.readOnly) throw new ReadOnlyFolderError(root.name);
    throw new Error("This folder is no longer connected.");
  }
  if (!(await ensureReadWrite(handle))) throw new Error(`FolderPilot needs access to “${handle.name}”. Click “Allow access” and try again.`);
  return handle;
}

/** Read a file's current contents from disk. Returns null if access was not granted or the file is gone. */
export async function getFile(file: FileRecord): Promise<File | null> {
  const memory = memoryRoots.get(file.rootId);
  if (memory) return memory.get(file.path) ?? null;
  const root = await rootHandle(file.rootId);
  if (!root || !(await hasReadWrite(root))) return null;
  try {
    return await (await resolveFile(root, file.path)).getFile();
  } catch {
    return null;
  }
}
