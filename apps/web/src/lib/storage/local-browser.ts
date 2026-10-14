/**
 * `local-browser` StorageAdapter: a folder on this computer, through the File System Access API (Chrome/Edge).
 * Refs are paths relative to the root folder. Versions are "size-lastModified".
 * Folders opened read-only (browsers without the API) can be read but every write throws ReadOnlyError.
 * There is no delete: trash moves the file into `.folderpilot-trash/<original path>`.
 */
import {
  ConflictError,
  NotFoundError,
  ReadOnlyError,
  TRASH_DIR,
  joinPath,
  shouldSkip,
  splitPath,
  type ChangeEvent,
  type FileEntry,
  type FileRef,
  type Page,
  type StorageAdapter,
  type WriteOptions,
} from "@folderpilot/core";
import { getDir, moveFile, trashPathFor } from "../actions/fs-ops";

export const versionOf = (file: { size: number; lastModified: number }) => `${file.size}-${file.lastModified}`;

/** "12-1700000000000" → { size: 12, mtime: 1700000000000 } (the index stores size and mtime, not the version). */
export function parseVersion(version: string): { size: number; mtime: number } | null {
  const m = /^(\d+)-(\d+)$/.exec(version);
  return m ? { size: Number(m[1]), mtime: Number(m[2]) } : null;
}

const isNotFound = (err: unknown) => err instanceof DOMException && (err.name === "NotFoundError" || err.name === "TypeMismatchError");

export type FileSource = { kind: "handle"; root: FileSystemDirectoryHandle } | { kind: "memory"; files: Map<string, File> };

export class LocalBrowserAdapter implements StorageAdapter {
  readonly id = "local-browser" as const;
  readonly readOnly: boolean;

  /** `getRoot` is called lazily, so the permission prompt only appears when something is actually written. */
  constructor(private readonly source: { kind: "handle"; getRoot: () => Promise<FileSystemDirectoryHandle> } | { kind: "memory"; files: Map<string, File> }) {
    this.readOnly = source.kind === "memory";
  }

  private async root(): Promise<FileSystemDirectoryHandle> {
    if (this.source.kind !== "handle") throw new ReadOnlyError();
    return this.source.getRoot();
  }

  private async fileAt(path: string): Promise<File | null> {
    if (this.source.kind === "memory") return this.source.files.get(path) ?? null;
    const { dir, name } = splitPath(path);
    try {
      return await (await (await getDir(await this.root(), dir)).getFileHandle(name)).getFile();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private toEntry(path: string, file: File): FileEntry {
    return { ref: { id: path }, path, name: splitPath(path).name, isFolder: false, size: file.size, mtime: file.lastModified, version: versionOf(file), ...(file.type ? { mime: file.type } : {}) };
  }

  private folderEntry(path: string): FileEntry {
    return { ref: { id: path }, path, name: splitPath(path).name, isFolder: true, size: 0, mtime: 0, version: "folder" };
  }

  private async checked(ref: FileRef, opts?: WriteOptions): Promise<FileEntry> {
    if (this.readOnly) throw new ReadOnlyError();
    const entry = await this.stat(ref);
    if (opts && entry.version !== opts.expectVersion) throw new ConflictError(`"${entry.name}" changed on disk.`, entry.version);
    return entry;
  }

  async list(path: string): Promise<Page<FileEntry>> {
    if (this.source.kind === "memory") {
      const prefix = path ? `${path}/` : "";
      const items: FileEntry[] = [];
      for (const [p, f] of this.source.files) if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) items.push(this.toEntry(p, f));
      return { items };
    }
    const dir = await getDir(await this.root(), path);
    const items: FileEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (shouldSkip(name)) continue;
      const p = joinPath(path, name);
      items.push(handle.kind === "directory" ? this.folderEntry(p) : this.toEntry(p, await (handle as FileSystemFileHandle).getFile()));
    }
    return { items };
  }

  async stat(ref: FileRef): Promise<FileEntry> {
    const entry = await this.resolve(ref.id);
    if (!entry) throw new NotFoundError(`${ref.id} was not found.`);
    return entry;
  }

  async resolve(path: string): Promise<FileEntry | null> {
    if (!path) return this.folderEntry("");
    const file = await this.fileAt(path);
    if (file) return this.toEntry(path, file);
    if (this.source.kind === "memory") {
      return [...this.source.files.keys()].some((p) => p.startsWith(`${path}/`)) ? this.folderEntry(path) : null;
    }
    try {
      await getDir(await this.root(), path);
      return this.folderEntry(path);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async readThumbnail(ref: FileRef, maxPx: number): Promise<Blob | null> {
    const file = await this.fileAt(ref.id);
    if (!file || !file.type.startsWith("image/") || typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") return null;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    } catch {
      return null;
    }
  }

  async readText(ref: FileRef, maxChars: number): Promise<string | null> {
    const file = await this.fileAt(ref.id);
    return file ? (await file.slice(0, maxChars * 4).text()).slice(0, maxChars) : null;
  }

  async download(ref: FileRef): Promise<ReadableStream<Uint8Array>> {
    const file = await this.fileAt(ref.id);
    if (!file) throw new NotFoundError(`${ref.id} was not found.`);
    return file.stream();
  }

  async move(ref: FileRef, newParent: FileRef, opts: WriteOptions & { newName?: string }): Promise<FileEntry> {
    const entry = await this.checked(ref, opts);
    const final = await moveFile(await this.root(), entry.path, joinPath(newParent.id, opts.newName ?? entry.name));
    return this.stat({ id: final });
  }

  async rename(ref: FileRef, newName: string, opts: WriteOptions): Promise<FileEntry> {
    const entry = await this.checked(ref, opts);
    const final = await moveFile(await this.root(), entry.path, joinPath(splitPath(entry.path).dir, newName));
    return this.stat({ id: final });
  }

  async createFolder(parent: FileRef, name: string): Promise<FileEntry> {
    if (this.readOnly) throw new ReadOnlyError();
    const path = joinPath(parent.id, name);
    await getDir(await this.root(), path, true);
    return this.folderEntry(path);
  }

  async trash(ref: FileRef, opts: WriteOptions): Promise<FileEntry> {
    const entry = await this.checked(ref, opts);
    const final = await moveFile(await this.root(), entry.path, trashPathFor(entry.path));
    return this.stat({ id: final });
  }

  async restore(ref: FileRef, originalPath: string): Promise<FileEntry> {
    const entry = await this.checked(ref);
    if (!entry.path.startsWith(`${TRASH_DIR}/`)) throw new NotFoundError(`${entry.path} is not in the FolderPilot Trash.`);
    const final = await moveFile(await this.root(), entry.path, originalPath);
    return this.stat({ id: final });
  }

  /** The browser can't watch folders; a change feed is a fresh listing (the indexer diffs it against the index). */
  async changes(cursor?: string): Promise<{ entries: ChangeEvent[]; cursor: string }> {
    const entries: ChangeEvent[] = [];
    const walk = async (path: string) => {
      for (const entry of (await this.list(path)).items) {
        if (entry.isFolder) await walk(entry.path);
        else if (!cursor || entry.mtime > Number(cursor)) entries.push({ type: "upsert", entry });
      }
    };
    await walk("");
    return { entries, cursor: String(Date.now()) };
  }
}
