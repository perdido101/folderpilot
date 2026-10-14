/**
 * `local-server` StorageAdapter: a folder on the server's disk (a mounted NAS/SMB share in self-hosted Private mode).
 * Refs are "/"-paths relative to the root. Version = "size-mtimeMs".
 * Phase 3 ships it read-only (dev sample space); moves, renames and trash arrive with Private mode (phase 9).
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  NotFoundError,
  ReadOnlyError,
  joinPath,
  shouldSkip,
  splitPath,
  type ChangeEvent,
  type FileEntry,
  type FileRef,
  type Page,
  type StorageAdapter,
} from "@folderpilot/core";

export class LocalServerAdapter implements StorageAdapter {
  readonly id = "local-server" as const;
  readonly readOnly = true;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Absolute path for a relative one; refuses anything that escapes the root (.., absolute paths, symlinks out). */
  private async abs(rel: string): Promise<string> {
    if (rel.includes("\0") || path.isAbsolute(rel) || rel.split("/").some((p) => p === "..")) throw new NotFoundError(`Invalid path: ${rel}`);
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new NotFoundError(`Invalid path: ${rel}`);
    let real: string;
    try {
      real = await fs.realpath(full);
    } catch {
      throw new NotFoundError(`${rel} was not found.`);
    }
    const realRoot = await fs.realpath(this.root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new NotFoundError(`Invalid path: ${rel}`);
    return real;
  }

  private entry(rel: string, st: { size: number; mtimeMs: number; isDirectory(): boolean }): FileEntry {
    const isFolder = st.isDirectory();
    const mtime = Math.round(st.mtimeMs);
    return { ref: { id: rel }, path: rel, name: splitPath(rel).name, isFolder, size: isFolder ? 0 : st.size, mtime, version: isFolder ? "folder" : `${st.size}-${mtime}` };
  }

  async list(rel: string): Promise<Page<FileEntry>> {
    const dir = await this.abs(rel);
    const items: FileEntry[] = [];
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      if (shouldSkip(d.name) || d.isSymbolicLink()) continue;
      if (!d.isFile() && !d.isDirectory()) continue;
      const childRel = joinPath(rel, d.name);
      items.push(this.entry(childRel, await fs.stat(path.join(dir, d.name))));
    }
    return { items };
  }

  async stat(ref: FileRef): Promise<FileEntry> {
    return this.entry(ref.id, await fs.stat(await this.abs(ref.id)));
  }

  async resolve(rel: string): Promise<FileEntry | null> {
    try {
      return await this.stat({ id: rel });
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /** Thumbnails are made by the worker from the bytes (sharp). */
  async readThumbnail(): Promise<Blob | null> {
    return null;
  }

  async readText(ref: FileRef, maxChars: number): Promise<string | null> {
    const handle = await fs.open(await this.abs(ref.id), "r");
    try {
      const buf = Buffer.alloc(maxChars * 4);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8").slice(0, maxChars);
    } finally {
      await handle.close();
    }
  }

  async download(ref: FileRef): Promise<ReadableStream<Uint8Array>> {
    return Readable.toWeb(createReadStream(await this.abs(ref.id))) as ReadableStream<Uint8Array>;
  }

  async move(): Promise<FileEntry> {
    throw new ReadOnlyError("This folder is read-only for now: moving files on the server arrives with Private mode (phase 9).");
  }
  async rename(): Promise<FileEntry> {
    throw new ReadOnlyError("This folder is read-only for now: renaming files on the server arrives with Private mode (phase 9).");
  }
  async createFolder(): Promise<FileEntry> {
    throw new ReadOnlyError("This folder is read-only for now: creating folders on the server arrives with Private mode (phase 9).");
  }
  async trash(): Promise<FileEntry> {
    throw new ReadOnlyError("This folder is read-only for now: trashing files on the server arrives with Private mode (phase 9).");
  }
  async restore(): Promise<FileEntry> {
    throw new ReadOnlyError("This folder is read-only for now.");
  }

  /** Full listing as upserts (a watcher arrives with phase 9). */
  async changes(cursor?: string): Promise<{ entries: ChangeEvent[]; cursor: string }> {
    const entries: ChangeEvent[] = [];
    const walk = async (rel: string) => {
      for (const e of (await this.list(rel)).items) {
        if (e.isFolder) await walk(e.path);
        else entries.push({ type: "upsert", entry: e });
      }
    };
    await walk("");
    return { entries, cursor: cursor ?? String(Date.now()) };
  }
}
