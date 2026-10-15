import Dexie, { type EntityTable } from "dexie";
import type { FileFlag, FileKind, FileStatus, PlanSource, PlanStatus, PlanStep as CorePlanStep, Rule, StepAction } from "@folderpilot/core";

export interface RootRecord {
  id: number;
  name: string;
  /** Missing for read-only folders opened without the File System Access API. */
  handle?: FileSystemDirectoryHandle;
  /** Opened via the standard file picker: files can be read but not moved/renamed on disk. */
  readOnly?: boolean;
  addedAt: number;
  indexedAt?: number;
  fileCount?: number;
}

export type { FileFlag, FileStatus } from "@folderpilot/core";

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
  /** AI document type, e.g. "invoice" (rules can match it). */
  docType?: string;
  confidence?: number;
  aiReason?: string;
  /** Who set the category: the AI, a rule, or the user. Used by explain(). */
  categorySource?: "ai" | "rule" | "user";
  /** Trash bookkeeping: where the file lived before it was trashed. */
  trashedFrom?: string;
  /** Reason given when flagged as suggested_delete. */
  flagReason?: string;
  /** Size-mtime the rules last looked at (rules run again when the file changes). */
  rulesChecked?: string;
}

export type NewFileRecord = Omit<FileRecord, "id">;

export type { PlanSource, PlanStatus, StepStatus } from "@folderpilot/core";
export type { StepAction } from "@folderpilot/core";

/** One change in the local browser index (numeric ids). */
export type PlanStep = Omit<CorePlanStep, "fileId" | "undoes"> & { fileId?: number; undoes?: number };
/** A step being proposed (the engine adds seq and status). */
export type StepInput = Omit<PlanStep, "seq" | "status">;

export interface PlanRecord {
  id: number;
  rootId: number;
  source: PlanSource;
  /** user:<id> | agent:<user> | rule:<id> (older plans: "user" / "agent" / "rule") */
  actor: string;
  summary: string;
  reason?: string;
  steps: PlanStep[];
  status: PlanStatus;
  createdAt: number;
  approvedBy?: string;
  approvedAt?: number;
  executedAt?: number;
  batchId?: string;
  /** Legacy (v2) field, no longer written. */
  errors?: string[];
}

/** Append-only: rows are never changed. An undo is a new row whose `undoesEventId` points at the original. */
export interface AuditRecord {
  id: number;
  at: number;
  /** user:<id> | agent:<user> | rule:<id> (older rows: "user" / "agent") */
  actor: string;
  action: StepAction | "undo";
  fileIds: number[];
  before?: string;
  after?: string;
  /** Machine values needed to undo the step. */
  from?: string;
  to?: string;
  fromVersion?: string;
  toVersion?: string;
  reason?: string;
  planId?: number;
  batchId: string;
  undoesEventId?: number;
  /** Legacy (v2) flag: rows undone before undo events existed. Never written anymore. */
  undone?: boolean;
  rootId: number;
}

/** Trash bookkeeping (original location and retention). */
export interface TrashRecord {
  fileId: number;
  rootId: number;
  originalPath: string;
  trashedBy: string;
  trashedAt: number;
  purgeAfter: number;
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
  trash!: EntityTable<TrashRecord, "fileId">;

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
    // v3: the shared core engine — per-step status, append-only audit with undo events, trash bookkeeping.
    this.version(3)
      .stores({
        audit: "++id, at, rootId, batchId, planId, actor, undoesEventId",
        trash: "fileId, rootId",
      })
      .upgrade(async (tx) => {
        await tx
          .table("plans")
          .toCollection()
          .modify((plan: PlanRecord & { undoBatchId?: string }) => {
            plan.steps = plan.steps.map((s, seq) => ({ ...s, seq, status: plan.status === "executed" ? "done" : "pending" }));
            // Old agent "undo" proposals can't be replayed by the new engine; the agent can propose them again.
            if (plan.undoBatchId && plan.status === "pending") plan.status = "cancelled";
            delete plan.undoBatchId;
          });
        const trashed = await tx.table("files").where("status").equals("trashed").toArray();
        await tx.table("trash").bulkPut(
          trashed
            .filter((f: FileRecord) => f.trashedFrom)
            .map((f: FileRecord) => ({ fileId: f.id, rootId: f.rootId, originalPath: f.trashedFrom!, trashedBy: "user", trashedAt: f.mtime, purgeAfter: Date.now() + 30 * 86_400_000 })),
        );
      });
  }
}

export const db = new FolderPilotDB();
export type { FolderPilotDB };
/** Lets tests open a database under another name (e.g. to test upgrades). */
export { FolderPilotDB as FolderPilotDBForTests };
