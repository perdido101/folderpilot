import { db, type FileRecord } from "./db";
import { ensureReadWrite, hasReadWrite, resolveFile } from "./fs-access";

const rootHandles = new Map<number, FileSystemDirectoryHandle>();

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
  if (!handle) throw new Error("This folder is no longer connected.");
  if (!(await ensureReadWrite(handle))) throw new Error(`FolderPilot needs access to “${handle.name}”. Click “Allow access” and try again.`);
  return handle;
}

/** Read a file's current contents from disk. Returns null if access was not granted or the file is gone. */
export async function getFile(file: FileRecord): Promise<File | null> {
  const root = await rootHandle(file.rootId);
  if (!root || !(await hasReadWrite(root))) return null;
  try {
    return await (await resolveFile(root, file.path)).getFile();
  } catch {
    return null;
  }
}
