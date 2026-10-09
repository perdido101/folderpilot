import { db, type FileRecord } from "./db";
import { hasReadWrite, resolveFile } from "./fs-access";

const rootHandles = new Map<number, FileSystemDirectoryHandle>();

async function rootHandle(rootId: number): Promise<FileSystemDirectoryHandle | null> {
  let handle = rootHandles.get(rootId);
  if (!handle) {
    handle = (await db.roots.get(rootId))?.handle;
    if (!handle) return null;
    rootHandles.set(rootId, handle);
  }
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
