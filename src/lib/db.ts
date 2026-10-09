import Dexie, { type EntityTable } from "dexie";
import type { FileKind } from "./file-kinds";
import type { Rule } from "./rules/types";

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
  // Local analysis (Phase 2). `analyzedLocally` is set once the worker has processed the file.
  analyzedLocally?: boolean;
  sha256?: string;
  dhash?: string;
  blurScore?: number;
  brightness?: number;
  width?: number;
  height?: number;
  exif?: Record<string, string | number>;
  textExcerpt?: string;
  // AI insights (Phase 3). Stored as suggestions; nothing on disk changes without a plan.
  category?: string;
  caption?: string;
  suggestedName?: string;
  client?: string;
  confidence?: number;
  aiReason?: string;
  /** Who set the category: the AI, a rule, or the user. Used by explain(). */
  categorySource?: "ai" | "rule" | "user";
  /** Trash bookkeeping: where the file lived before it was trashed. */
  trashedFrom?: string;
  /** Reason given when flagged as suggested_delete. */
  flagReason?: string;
}

export type NewFileRecord = Omit<FileRecord, "id">;

export type PlanSource = "agent" | "rule" | "user";
export type PlanStatus = "pending" | "approved" | "executed" | "cancelled";
export type StepAction =
  | "move"
  | "rename"
  | "tag"
  | "untag"
  | "caption"
  | "category"
  | "trash"
  | "restore"
  | "flag"
  | "unflag"
  | "rule_create"
  | "rule_update";

/** One change. `before`/`after` are display strings; `from`/`to` carry machine values (paths, JSON). */
export interface PlanStep {
  fileId?: number;
  action: StepAction;
  from?: string;
  to?: string;
  before?: string;
  after?: string;
  /** Overrides the plan actor in the audit log (e.g. "rule:3" inside a combined rules plan). */
  actor?: string;
}

export interface PlanRecord {
  id: number;
  rootId: number;
  source: PlanSource;
  /** e.g. "rule:3" when source is a rule. */
  actor: string;
  summary: string;
  reason?: string;
  steps: PlanStep[];
  status: PlanStatus;
  createdAt: number;
  executedAt?: number;
  batchId?: string;
  errors?: string[];
  /** When set, approving this plan undoes that batch (the agent's undo tool proposes these). */
  undoBatchId?: string;
}

export interface AuditRecord {
  id: number;
  at: number;
  /** 'user' | 'agent' | 'rule:<id>' */
  actor: string;
  action: StepAction | "undo";
  fileIds: number[];
  before?: string;
  after?: string;
  /** Machine values needed to undo the step. */
  from?: string;
  to?: string;
  reason?: string;
  planId?: number;
  batchId: string;
  undone: boolean;
  rootId: number;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface EmbeddingRecord {
  fileId: number;
  rootId: number;
  model: string;
  /** Hash of the text that was embedded, so stale vectors can be refreshed. */
  textHash: string;
  vector: number[];
}

class FolderPilotDB extends Dexie {
  roots!: EntityTable<RootRecord, "id">;
  files!: EntityTable<FileRecord, "id">;
  rules!: EntityTable<Rule, "id">;
  plans!: EntityTable<PlanRecord, "id">;
  audit!: EntityTable<AuditRecord, "id">;
  settings!: EntityTable<SettingRecord, "key">;
  embeddings!: EntityTable<EmbeddingRecord, "fileId">;

  constructor(name = "folderpilot") {
    super(name);
    this.version(1).stores({
      roots: "++id, name, addedAt",
      files: "++id, rootId, &[rootId+path], name, ext, kind, status, category, *flags, *tags, sha256",
    });
    this.version(2).stores({
      files: "++id, rootId, &[rootId+path], name, ext, kind, status, category, *flags, *tags, sha256, [rootId+status]",
      rules: "++id, priority, enabled, type",
      plans: "++id, rootId, status, createdAt, batchId",
      audit: "++id, at, rootId, batchId, planId, actor",
      settings: "key",
      embeddings: "fileId, rootId",
    });
  }
}

export const db = new FolderPilotDB();
export type { FolderPilotDB };
