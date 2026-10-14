import type { AdapterId } from "../types";

/**
 * A provider-specific handle to a file or folder. `id` is whatever the provider uses
 * (a Drive file id, an S3 object id, or the relative path for local folders).
 */
export interface FileRef {
  id: string;
}

export interface FileEntry {
  ref: FileRef;
  /** "/"-separated path relative to the space root, e.g. "Clients/Alpha/nda.pdf". */
  path: string;
  name: string;
  isFolder: boolean;
  size: number;
  mtime: number;
  /** Changes whenever the content or metadata changes (etag, rev, or size+mtime). Used for conflict checks. */
  version: string;
  mime?: string;
}

export interface Page<T> {
  items: T[];
  cursor?: string;
}

export type ChangeEvent =
  | { type: "upsert"; entry: FileEntry }
  | { type: "removed"; ref: FileRef; path?: string };

export interface Subscription {
  id: string;
  expiresAt?: number;
}

export interface WriteOptions {
  /** The version the change was planned against. A different current version is a conflict. */
  expectVersion: string;
}

/**
 * All file I/O goes through this interface (spec §4). Nothing else touches files.
 * There is deliberately no delete: `trash` is recoverable, and only the action engine
 * calls it — for plans approved and initiated by a human.
 */
export interface StorageAdapter {
  readonly id: AdapterId;
  /** Opened without write access (e.g. a browser without the File System Access API). Writes throw ReadOnlyError. */
  readonly readOnly?: boolean;
  list(path: string, cursor?: string): Promise<Page<FileEntry>>;
  stat(ref: FileRef): Promise<FileEntry>;
  /** Look up an entry by path; null when nothing is there. Used for folder targets and crash recovery. */
  resolve(path: string): Promise<FileEntry | null>;
  readThumbnail(ref: FileRef, maxPx: number): Promise<Blob | null>;
  readText(ref: FileRef, maxChars: number): Promise<string | null>;
  /** For preview/download only. */
  download(ref: FileRef): Promise<ReadableStream<Uint8Array>>;
  upload?(parent: FileRef, file: Blob, name: string): Promise<FileEntry>;
  /** Move into `newParent`, optionally renaming in the same call. Never overwrites: a taken name gets " (2)". */
  move(ref: FileRef, newParent: FileRef, opts: WriteOptions & { newName?: string }): Promise<FileEntry>;
  rename(ref: FileRef, newName: string, opts: WriteOptions): Promise<FileEntry>;
  /** Returns the existing folder if it is already there. */
  createFolder(parent: FileRef, name: string): Promise<FileEntry>;
  /** HUMAN-ONLY (enforced by the action engine). Returns the entry as it now exists in the trash. */
  trash(ref: FileRef, opts: WriteOptions): Promise<FileEntry>;
  /** Put a trashed entry back at `originalPath` (or next to it if the name is taken). */
  restore(ref: FileRef, originalPath: string): Promise<FileEntry>;
  changes(cursor?: string): Promise<{ entries: ChangeEvent[]; cursor: string }>;
  subscribe?(webhookUrl: string): Promise<Subscription>;
}

/** The root folder of a space, for `move`/`createFolder` targets. */
export const ROOT_REF: FileRef = { id: "" };

export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: "conflict" | "not_found" | "read_only" | "provider",
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export class ConflictError extends StorageError {
  constructor(
    message: string,
    readonly currentVersion?: string,
  ) {
    super(message, "conflict");
    this.name = "ConflictError";
  }
}

export class NotFoundError extends StorageError {
  constructor(message: string) {
    super(message, "not_found");
    this.name = "NotFoundError";
  }
}

export class ReadOnlyError extends StorageError {
  constructor(message = "This folder was opened read-only, so files can't be moved, renamed or trashed here.") {
    super(message, "read_only");
    this.name = "ReadOnlyError";
  }
}

export const splitPath = (path: string): { dir: string; name: string } => {
  const i = path.lastIndexOf("/");
  return i === -1 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
};

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
