import { db, type FileRecord, type NewFileRecord } from "./db";
import { extOf, kindOf, shouldSkip } from "./file-kinds";

export interface IndexProgress {
  scanned: number;
  dirs: number;
  currentPath: string;
}

interface WalkEntry {
  path: string;
  getFile: () => Promise<File>;
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
      yield { path, getFile: () => (handle as FileSystemFileHandle).getFile() };
    }
  }
}

const BATCH_SIZE = 200;

/** Analysis fields that become stale when a file's content changes. */
const RESET: Partial<FileRecord> = {
  analyzedLocally: false,
  sha256: undefined,
  dhash: undefined,
  blurScore: undefined,
  brightness: undefined,
  width: undefined,
  height: undefined,
  exif: undefined,
  textExcerpt: undefined,
};

/**
 * Recursively index a folder into Dexie. Unchanged files (same path, size and mtime) keep their
 * analysis and AI results; changed files are re-queued; files that disappeared are dropped from the index.
 * Directory walking is async I/O (not CPU-bound), so it stays on the main thread;
 * hashing and image analysis run in Web Workers.
 */
export async function indexRoot(
  rootId: number,
  root: FileSystemDirectoryHandle | Map<string, File>,
  onProgress: (p: IndexProgress) => void,
  signal: AbortSignal,
): Promise<number> {
  const existing = new Map((await db.files.where("rootId").equals(rootId).toArray()).map((f) => [f.path, f]));
  const seen = new Set<number>();
  const progress: IndexProgress = { scanned: 0, dirs: 0, currentPath: "" };
  const entries = root instanceof Map ? memoryEntries(root, signal) : walk(root, "", signal, () => progress.dirs++);
  let adds: NewFileRecord[] = [];
  let updates: { key: number; changes: Partial<FileRecord> }[] = [];
  const flush = async () => {
    if (adds.length) await db.files.bulkAdd(adds);
    if (updates.length) await db.files.bulkUpdate(updates);
    adds = [];
    updates = [];
  };

  for await (const entry of entries) {
    let file: File;
    try {
      file = await entry.getFile();
    } catch {
      continue; // locked or vanished mid-scan
    }
    const prev = existing.get(entry.path);
    if (prev) {
      seen.add(prev.id);
      if (prev.size !== file.size || prev.mtime !== file.lastModified || prev.status === "trashed") {
        updates.push({ key: prev.id, changes: { ...RESET, size: file.size, mtime: file.lastModified, status: "indexed", trashedFrom: undefined } });
      }
    } else {
      const ext = extOf(file.name);
      adds.push({
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
    }
    progress.scanned++;
    progress.currentPath = entry.path;
    if (adds.length + updates.length >= BATCH_SIZE || progress.scanned % BATCH_SIZE === 0) {
      await flush();
      onProgress({ ...progress });
    }
  }
  await flush();
  onProgress({ ...progress });

  if (!signal.aborted) {
    // Files that are gone from disk leave the index. Trashed files live in the (skipped) trash folder.
    const gone = [...existing.values()].filter((f) => !seen.has(f.id) && f.status !== "trashed").map((f) => f.id);
    await db.files.bulkDelete(gone);
    await db.roots.update(rootId, { indexedAt: Date.now(), fileCount: progress.scanned });
  }
  return progress.scanned;
}

async function* memoryEntries(files: Map<string, File>, signal: AbortSignal): AsyncGenerator<WalkEntry> {
  for (const [path, file] of files) {
    if (signal.aborted) return;
    yield { path, getFile: async () => file };
  }
}

/** Read-only folders are matched by name (there is no handle to compare). */
export async function upsertReadOnlyRoot(name: string): Promise<number> {
  const existing = (await db.roots.toArray()).find((r) => r.readOnly && r.name === name);
  if (existing) return existing.id;
  return db.roots.add({ name, readOnly: true, addedAt: Date.now() });
}

/** Add a root (or reuse the existing record if the same folder was connected before). */
export async function upsertRoot(handle: FileSystemDirectoryHandle): Promise<number> {
  for (const existing of await db.roots.toArray()) {
    if (existing.handle && (await existing.handle.isSameEntry(handle))) {
      await db.roots.update(existing.id, { handle, name: handle.name });
      return existing.id;
    }
  }
  return db.roots.add({ name: handle.name, handle, addedAt: Date.now() });
}
