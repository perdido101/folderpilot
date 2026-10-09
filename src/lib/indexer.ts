import { db, type NewFileRecord } from "./db";
import { extOf, kindOf, shouldSkip } from "./file-kinds";

export interface IndexProgress {
  scanned: number;
  dirs: number;
  currentPath: string;
}

interface WalkEntry {
  path: string;
  handle: FileSystemFileHandle;
}

async function* walk(dir: FileSystemDirectoryHandle, prefix: string, signal: AbortSignal, onDir: () => void): AsyncGenerator<WalkEntry> {
  onDir();
  for await (const [name, handle] of dir.entries()) {
    if (signal.aborted) return;
    if (shouldSkip(name)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      yield* walk(handle as FileSystemDirectoryHandle, path, signal, onDir);
    } else {
      yield { path, handle: handle as FileSystemFileHandle };
    }
  }
}

const BATCH_SIZE = 200;

/**
 * Recursively index a folder into Dexie. Replaces any previous index for this root.
 * Directory walking is async I/O (not CPU-bound), so it stays on the main thread;
 * hashing/image analysis in later phases goes to Web Workers.
 */
export async function indexRoot(
  rootId: number,
  root: FileSystemDirectoryHandle,
  onProgress: (p: IndexProgress) => void,
  signal: AbortSignal,
): Promise<number> {
  await db.files.where("rootId").equals(rootId).delete();

  const progress: IndexProgress = { scanned: 0, dirs: 0, currentPath: "" };
  let batch: NewFileRecord[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await db.files.bulkAdd(batch);
    batch = [];
  };

  for await (const entry of walk(root, "", signal, () => progress.dirs++)) {
    let file: File;
    try {
      file = await entry.handle.getFile();
    } catch {
      continue; // locked or vanished mid-scan
    }
    const ext = extOf(file.name);
    batch.push({
      rootId,
      path: entry.path,
      name: file.name,
      ext,
      kind: kindOf(ext),
      size: file.size,
      mtime: file.lastModified,
      status: "indexed",
      flags: [],
      tags: [],
    });
    progress.scanned++;
    progress.currentPath = entry.path;
    if (batch.length >= BATCH_SIZE) {
      await flush();
      onProgress({ ...progress });
    }
  }
  await flush();
  onProgress({ ...progress });

  if (!signal.aborted) {
    await db.roots.update(rootId, { indexedAt: Date.now(), fileCount: progress.scanned });
  }
  return progress.scanned;
}

/** Add a root (or reuse the existing record if the same folder was connected before). */
export async function upsertRoot(handle: FileSystemDirectoryHandle): Promise<number> {
  for (const existing of await db.roots.toArray()) {
    if (await existing.handle.isSameEntry(handle)) {
      await db.roots.update(existing.id, { handle, name: handle.name });
      return existing.id;
    }
  }
  return db.roots.add({ name: handle.name, handle, addedAt: Date.now() });
}
