import type { NewRule, Rule } from "../rules/types";
import type { FileRef } from "../storage/types";
import type { Id, IndexedFile, ProposedStep, StepAction } from "../types";

export type PlanSource = "user" | "agent" | "rule" | "mcp";
export type PlanStatus = "pending" | "approved" | "executing" | "executed" | "partially_failed" | "cancelled";
export type StepStatus = "pending" | "done" | "failed" | "conflicted" | "skipped";

export interface PlanStep extends ProposedStep {
  /** Position in the plan (0-based, stable across edits). */
  seq: number;
  status: StepStatus;
  /** File version the step was planned against; a different version on disk marks the step conflicted. */
  expectVersion?: string;
  error?: string;
  /** Undo plans: the audit event this step reverts. `action` is then the original event's action. */
  undoes?: Id;
}

export interface Plan {
  id: Id;
  spaceId: Id;
  source: PlanSource;
  /** user:<id> | agent:<user> | rule:<id> | mcp:<client>:<user> */
  actor: string;
  summary: string;
  reason?: string;
  status: PlanStatus;
  steps: PlanStep[];
  createdAt: number;
  approvedBy?: string;
  approvedAt?: number;
  executedAt?: number;
  /** All audit events written while executing this plan share it. */
  batchId?: string;
}

export type NewPlan = Omit<Plan, "id">;

export interface PlanInput {
  spaceId: Id;
  source: PlanSource;
  actor: string;
  summary: string;
  reason?: string;
  steps: (ProposedStep & { undoes?: Id; expectVersion?: string })[];
}

/** A file as the engine sees it: the shared index fields plus where it lives in its space. */
export interface EngineFile extends IndexedFile {
  spaceId: Id;
  ref: FileRef;
  version?: string;
  trashedFrom?: string;
  categorySource?: "ai" | "rule" | "user";
  flagReason?: string;
}

/** Fields the engine may change in the index. `undefined` clears a value. */
export type FilePatch = Partial<
  Pick<EngineFile, "path" | "name" | "ext" | "kind" | "ref" | "version" | "status" | "tags" | "caption" | "category" | "categorySource" | "flags" | "flagReason" | "trashedFrom">
>;

export interface AuditEvent {
  id: Id;
  /** Monotonic order of the whole log (timestamps can tie). */
  seq: number;
  at: number;
  spaceId: Id;
  actor: string;
  action: StepAction | "undo";
  fileIds: Id[];
  /** Display values. */
  before?: string;
  after?: string;
  /** Machine values needed to undo the step. */
  from?: string;
  to?: string;
  fromVersion?: string;
  toVersion?: string;
  reason?: string;
  planId?: Id;
  batchId: string;
  /** Set on undo events: the event this one reverted. The original row is never modified. */
  undoesEventId?: Id;
}

export type NewAuditEvent = Omit<AuditEvent, "id" | "seq">;

export interface AuditQuery {
  spaceId?: Id;
  batchId?: string;
  planId?: Id;
  /** e.g. "agent:" for "everything the agent did". */
  actorPrefix?: string;
  /** Epoch ms, inclusive. */
  since?: number;
}

export interface TrashRecord {
  fileId: Id;
  spaceId: Id;
  originalPath: string;
  trashedBy: string;
  trashedAt: number;
  /** Retention: kept at least until then (default 30 days). */
  purgeAfter: number;
}

/**
 * Where the engine keeps the index, plans, audit log, trash bookkeeping and rules.
 * Implemented over Dexie (browser) and Postgres (server). The audit log is append-only:
 * there is intentionally no method to update or delete an audit event.
 */
export interface EngineStore {
  /** Run `fn` atomically (index change + audit event + step status are written together). */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  getFile(id: Id): Promise<EngineFile | undefined>;
  updateFile(id: Id, patch: FilePatch): Promise<void>;

  insertPlan(plan: NewPlan): Promise<Id>;
  getPlan(id: Id): Promise<Plan | undefined>;
  updatePlan(id: Id, patch: Partial<Omit<Plan, "id" | "steps" | "spaceId" | "source" | "actor">>): Promise<void>;
  /** Only used while a plan is pending (Edit). */
  replaceSteps(id: Id, steps: PlanStep[]): Promise<void>;
  updateStep(planId: Id, seq: number, patch: Partial<Pick<PlanStep, "status" | "error" | "expectVersion">>): Promise<void>;

  appendAudit(event: NewAuditEvent): Promise<Id>;
  getAuditEvents(ids: Id[]): Promise<AuditEvent[]>;
  findAudit(query: AuditQuery): Promise<AuditEvent[]>;
  /** Undo events that point at any of `eventIds`. */
  findUndoEvents(eventIds: Id[]): Promise<AuditEvent[]>;

  putTrash(record: TrashRecord): Promise<void>;
  getTrash(fileId: Id): Promise<TrashRecord | undefined>;
  clearTrash(fileId: Id): Promise<void>;

  createRule(rule: NewRule): Promise<Rule["id"]>;
  getRule(id: Rule["id"]): Promise<Rule | undefined>;
  putRule(rule: Rule): Promise<void>;
  removeRule(id: Rule["id"]): Promise<void>;
}
