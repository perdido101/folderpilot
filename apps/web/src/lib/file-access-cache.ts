import { db, type FileRecord } from "./db";
import i18n from "@/i18n";
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
    super(i18n.t("actions:errors.readOnlyFolder", { name }));
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
    throw new Error(i18n.t("actions:errors.notConnected"));
  }
  if (!(await ensureReadWrite(handle))) throw new Error(i18n.t("actions:errors.needsAccess", { name: handle.name }));
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
