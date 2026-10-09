import Dexie, { type EntityTable } from "dexie";
import type { FileKind } from "./file-kinds";

export interface RootRecord {
  id: number;
  name: string;
  handle: FileSystemDirectoryHandle;
  addedAt: number;
  indexedAt?: number;
  fileCount?: number;
}

export type FileStatus = "indexed" | "analyzed" | "needs_review" | "organized" | "trashed";
export type FileFlag =
  | "duplicate"
  | "near_duplicate"
  | "blurry"
  | "dark"
  | "tiny"
  | "screenshot"
  | "suggested_delete";

export interface FileRecord {
  id: number;
  rootId: number;
  /** Path relative to the root, using "/" separators, e.g. "Clients/Alpha/nda.pdf". */
  path: string;
  name: string;
  ext: string;
  kind: FileKind;
  size: number;
  mtime: number;
  status: FileStatus;
  flags: FileFlag[];
  tags: string[];
  // Filled by later phases (analysis worker, AI pipeline).
  sha256?: string;
  dhash?: string;
  blurScore?: number;
  brightness?: number;
  width?: number;
  height?: number;
  exif?: Record<string, unknown>;
  textExcerpt?: string;
  category?: string;
  caption?: string;
  suggestedName?: string;
  confidence?: number;
}

export type NewFileRecord = Omit<FileRecord, "id">;

class FolderPilotDB extends Dexie {
  roots!: EntityTable<RootRecord, "id">;
  files!: EntityTable<FileRecord, "id">;

  constructor() {
    super("folderpilot");
    this.version(1).stores({
      roots: "++id, name, addedAt",
      files: "++id, rootId, &[rootId+path], name, ext, kind, status, category, *flags, *tags, sha256",
    });
  }
}

export const db = new FolderPilotDB();
