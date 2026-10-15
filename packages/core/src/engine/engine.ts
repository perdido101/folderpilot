/**
 * The action & plan engine (spec §7) — the ONLY code path that changes files.
 *
 *   createPlan (pending) ──approve──▶ execute ──▶ one audit event per step (one batch) ──▶ undo = inverse plan
 *
 * - Every change is a plan first; nothing touches storage before a person with `plan:approve` approves it.
 * - Trash and restore exist only in plans made by a person (source "user", actor "user:<id>"). Agents, rules and
 *   MCP clients can't trash — checked when the plan is created, approved and executed. There is no delete at all.
 * - File steps carry the version they were planned against; a changed or missing file marks the step "conflicted"
 *   and nothing is overwritten. The person then skips it or re-plans it against the current version.
 * - Step status and its audit event are written in one transaction, so a crashed run can be resumed safely.
 * - Undo writes NEW audit events (`undoesEventId`); the log itself is append-only.
 */
import { kindOf, extOf } from "../file-kinds";
import { can } from "../permissions";
import type { Rule, NewRule } from "../rules/types";
import { ConflictError, NotFoundError, ROOT_REF, ReadOnlyError, StorageError, splitPath, type FileEntry, type FileRef, type StorageAdapter } from "../storage/types";
import type { FileFlag, FileStatus, Id, Role, StepAction } from "../types";
import type { AuditEvent, EngineFile, EngineStore, NewAuditEvent, Plan, PlanInput, PlanSource, PlanStatus, PlanStep } from "./types";

export const DEFAULT_TRASH_RETENTION_DAYS = 30;
const DAY = 86_400_000;

export interface Approver {
  /** Becomes the audit actor `user:<userId>` for user plans and undo. */
  userId: string;
  role: Role;
}

export interface ProgressEvent {
  planId: Id;
  done: number;
  total: number;
  step: PlanStep;
}

export interface ExecResult {
  planId: Id;
  batchId: string;
  status: PlanStatus;
  /** Counts for this run. */
  done: number;
  failed: number;
  conflicted: number;
  skipped: number;
  errors: string[];
  /** Actions of the steps that completed in this run (for "Moved 3 files · Tagged 1 file"). */
  doneActions: StepAction[];
}

export interface EngineOptions {
  store: EngineStore;
  adapterFor: (spaceId: Id) => Promise<StorageAdapter>;
  now?: () => number;
  newBatchId?: () => string;
  trashRetentionDays?: number;
}

export type UndoTarget = { eventIds: Id[] } | { batchId: string } | { since: number; actorPrefix?: string };

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "forbidden" | "invalid_state" | "invalid_plan" | "nothing_to_undo",
  ) {
    super(message);
    this.name = "EngineError";
  }
}

const PATH_ACTIONS = new Set<StepAction>(["move", "rename", "trash", "restore"]);
const FILE_ACTIONS = new Set<StepAction>(["move", "rename", "tag", "untag", "caption", "category", "trash", "restore", "flag", "unflag"]);
const KNOWN_ACTIONS = new Set<StepAction>([...FILE_ACTIONS, "createFolder", "rule_create", "rule_update"]);

export const isHumanActor = (actor: string) => actor.startsWith("user:") && actor.length > 5;

/** What a step actually does: an undo step reverses its original action (undoing a trash restores). */
export function effectiveAction(step: Pick<PlanStep, "action" | "undoes">): StepAction {
  if (step.undoes === undefined) return step.action;
  if (step.action === "trash") return "restore";
  if (step.action === "restore") return "trash";
  return step.action;
}

const isTrashLike = (step: Pick<PlanStep, "action" | "undoes">) => {
  const a = effectiveAction(step);
  return a === "trash" || a === "restore";
};

function assertHumanOnly(plan: { source: PlanSource; actor: string; steps: Pick<PlanStep, "action" | "undoes">[] }) {
  if (plan.steps.some(isTrashLike) && !(plan.source === "user" && isHumanActor(plan.actor))) {
    throw new EngineError("Only a person can move files to the Trash or restore them. Agents, rules and connected apps can only flag files.", "forbidden");
  }
}

/** Permission a role needs for one step (spec §6 roles; see permissions.ts). */
function stepAllowed(role: Role, step: Pick<PlanStep, "action" | "undoes">): boolean {
  const a = effectiveAction(step);
  if (a === "trash") return can(role, "file", "trash");
  if (a === "restore") return can(role, "file", "restore");
  if (a === "rule_create" || a === "rule_update") return can(role, "rule", "manage");
  return can(role, "file", "organize");
}

export const fileCountOf = (steps: Pick<PlanStep, "fileId">[]) => new Set(steps.flatMap((s) => (s.fileId === undefined ? [] : [String(s.fileId)]))).size;

export interface AutoRunSettings {
  /** Agent/MCP plans touching at most this many files run without approval. 0 = never (default). */
  maxFiles: number;
  /** Also allow MCP clients to auto-run small plans (default off, §10). */
  allowMcp: boolean;
}

/** Whether a plan may skip the approval step (§2): small agent plans under the admin threshold, or rules set to "auto". Trash never auto-runs. */
export function canAutoRun(plan: Pick<Plan, "source" | "steps">, settings: AutoRunSettings, ruleMode?: "suggest" | "auto"): boolean {
  if (plan.steps.length === 0 || plan.steps.some(isTrashLike)) return false;
  const small = settings.maxFiles > 0 && fileCountOf(plan.steps) <= settings.maxFiles;
  switch (plan.source) {
    case "user":
      return true;
    case "rule":
      return ruleMode === "auto";
    case "agent":
      return small;
    case "mcp":
      return settings.allowMcp && small;
  }
}

const json = (v: unknown) => JSON.stringify(v);
const pathFields = (path: string) => {
  const { name } = splitPath(path);
  const ext = extOf(name);
  return { path, name, ext, kind: kindOf(ext) };
};
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const restingStatus = (f: Pick<EngineFile, "category">): FileStatus => (f.category ? "analyzed" : "indexed");

interface Outcome {
  /** Store writes for this step; returns the audit fields. Runs inside the transaction. */
  commit: () => Promise<Partial<NewAuditEvent>>;
}

class Skip extends Error {}

export function createEngine(opts: EngineOptions) {
  const { store } = opts;
  const now = opts.now ?? (() => Date.now());
  const newBatchId = opts.newBatchId ?? (() => globalThis.crypto.randomUUID());
  const retentionMs = (opts.trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS) * DAY;

  async function requirePlan(planId: Id): Promise<Plan> {
    const plan = await store.getPlan(planId);
    if (!plan) throw new EngineError("Plan not found.", "not_found");
    return plan;
  }

  async function requireFile(id: Id | undefined): Promise<EngineFile> {
    if (id === undefined) throw new EngineError("This step doesn't name a file.", "invalid_plan");
    const file = await store.getFile(id);
    if (!file) throw new NotFoundError("The file is no longer in the index.");
    return file;
  }

  // ── Plans ─────────────────────────────────────────────────────────────

  async function createPlan(input: PlanInput): Promise<Id> {
    for (const s of input.steps) {
      if (!KNOWN_ACTIONS.has(s.action)) throw new EngineError(`Unknown step action "${s.action}".`, "invalid_plan");
      if (FILE_ACTIONS.has(s.action) && s.fileId === undefined) throw new EngineError(`A ${s.action} step needs a file.`, "invalid_plan");
    }
    assertHumanOnly(input);
    const steps: PlanStep[] = [];
    const seen = new Set<string>();
    for (const [seq, s] of input.steps.entries()) {
      let expectVersion = s.expectVersion;
      // Only a file's first storage step pins the planned version; later steps check against what the earlier step left.
      const first = s.fileId !== undefined && !seen.has(String(s.fileId));
      if (expectVersion === undefined && first && s.undoes === undefined && PATH_ACTIONS.has(s.action) && s.fileId !== undefined) {
        expectVersion = (await store.getFile(s.fileId))?.version;
      }
      if (s.fileId !== undefined && PATH_ACTIONS.has(s.action)) seen.add(String(s.fileId));
      steps.push({ ...s, seq, status: "pending", ...(expectVersion !== undefined ? { expectVersion } : {}) });
    }
    return store.insertPlan({
      spaceId: input.spaceId,
      source: input.source,
      actor: input.actor,
      summary: input.summary,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      status: "pending",
      steps,
      createdAt: now(),
    });
  }

  /** "Edit": keep only some steps of a pending plan. */
  async function keepSteps(planId: Id, keepSeqs: number[]) {
    const plan = await requirePlan(planId);
    if (plan.status !== "pending") throw new EngineError("Only pending plans can be edited.", "invalid_state");
    const keep = new Set(keepSeqs);
    await store.replaceSteps(
      planId,
      plan.steps.filter((s) => keep.has(s.seq)),
    );
  }

  async function cancel(planId: Id) {
    const plan = await requirePlan(planId);
    if (plan.status !== "pending" && plan.status !== "approved") throw new EngineError(`This plan is already ${plan.status.replace("_", " ")}.`, "invalid_state");
    await store.updatePlan(planId, { status: "cancelled" });
  }

  async function approve(planId: Id, approver: Approver) {
    const plan = await requirePlan(planId);
    if (plan.status !== "pending") throw new EngineError(`This plan is already ${plan.status.replace("_", " ")}.`, "invalid_state");
    if (!can(approver.role, "plan", "approve")) throw new EngineError("Your role can propose changes but not approve them.", "forbidden");
    const denied = plan.steps.find((s) => !stepAllowed(approver.role, s));
    if (denied) throw new EngineError(`Your role can't approve "${effectiveAction(denied)}" steps.`, "forbidden");
    assertHumanOnly(plan);
    await store.updatePlan(planId, { status: "approved", approvedBy: approver.userId, approvedAt: now() });
  }

  /**
   * Approval without a person, only for plans made by a rule a person set to "auto" (spec §2). Rules can't trash, and
   * canAutoRun() refuses trash/restore anyway. The plan keeps the rule as its actor; approvedBy stays empty.
   */
  async function autoApprove(planId: Id) {
    const plan = await requirePlan(planId);
    if (plan.status !== "pending") throw new EngineError(`This plan is already ${plan.status.replace("_", " ")}.`, "invalid_state");
    const ruleId = plan.source === "rule" && plan.actor.startsWith("rule:") ? plan.actor.slice(5) : null;
    const rule = ruleId ? await store.getRule(/^\d+$/.test(ruleId) ? Number(ruleId) : ruleId) : undefined;
    if (!rule || rule.archived || !rule.enabled) throw new EngineError("Only plans from an enabled rule can run without approval.", "forbidden");
    if (!canAutoRun(plan, { maxFiles: 0, allowMcp: false }, rule.mode ?? "suggest")) {
      throw new EngineError(`Rule "${rule.name}" is set to suggest, so its changes need approval.`, "forbidden");
    }
    await store.updatePlan(planId, { status: "approved", approvedAt: now() });
  }

  /**
   * Admins may let small agent (and, if allowed, MCP) plans run without approval (spec §2). Rule changes, trash and
   * restore always need a person. Returns whether the plan was approved; otherwise it stays pending.
   */
  async function autoApproveSmall(planId: Id, settings: AutoRunSettings): Promise<boolean> {
    const plan = await requirePlan(planId);
    if (plan.status !== "pending" || (plan.source !== "agent" && plan.source !== "mcp")) return false;
    if (plan.steps.some((s) => s.action === "rule_create" || s.action === "rule_update" || s.fileId === undefined)) return false;
    if (!canAutoRun(plan, settings)) return false;
    await store.updatePlan(planId, { status: "approved", approvedAt: now() });
    return true;
  }

  // ── Execution ─────────────────────────────────────────────────────────

  async function execute(planId: Id, run: { onProgress?: (e: ProgressEvent) => void } = {}): Promise<ExecResult> {
    let plan = await requirePlan(planId);
    if (plan.status === "pending") throw new EngineError("This plan hasn't been approved yet.", "invalid_state");
    if (plan.status === "cancelled") throw new EngineError("This plan was cancelled.", "invalid_state");
    assertHumanOnly(plan);

    const batchId = plan.batchId ?? newBatchId();
    const result: ExecResult = { planId, batchId, status: plan.status, done: 0, failed: 0, conflicted: 0, skipped: 0, errors: [], doneActions: [] };
    const pending = plan.steps.filter((s) => s.status === "pending");
    if (pending.length === 0 && plan.status === "executed") return result;

    await store.updatePlan(planId, { status: "executing", batchId });
    let adapter: StorageAdapter | null = null;
    const getAdapter = async () => (adapter ??= await opts.adapterFor(plan.spaceId));
    const total = plan.steps.length;
    let finished = plan.steps.length - pending.length;
    // Files already changed by this plan: their later steps check against the version the earlier step left behind.
    const touched = new Set(plan.steps.flatMap((s) => (s.status === "done" && s.fileId !== undefined ? [String(s.fileId)] : [])));

    for (const step of pending) {
      try {
        const outcome = step.undoes !== undefined ? await revertStep(plan, step, getAdapter, touched) : await applyStep(plan, step, getAdapter);
        await store.transaction(async () => {
          const fields = await outcome.commit();
          await store.appendAudit({
            at: now(),
            spaceId: plan.spaceId,
            actor: step.actor ?? plan.actor,
            action: step.action,
            fileIds: step.fileId !== undefined ? [step.fileId] : [],
            reason: plan.reason ?? plan.summary,
            planId,
            batchId,
            ...fields,
          });
          await store.updateStep(planId, step.seq, { status: "done" });
        });
        result.done++;
        result.doneActions.push(effectiveAction(step));
        if (step.fileId !== undefined) touched.add(String(step.fileId));
      } catch (err) {
        if (err instanceof Skip) {
          await store.updateStep(planId, step.seq, { status: "skipped", error: err.message });
          result.skipped++;
        } else if (err instanceof ConflictError || (err instanceof StorageError && err.code === "not_found")) {
          await store.updateStep(planId, step.seq, { status: "conflicted", error: err.message });
          result.conflicted++;
          result.errors.push(err.message);
        } else {
          await store.updateStep(planId, step.seq, { status: "failed", error: errorText(err) });
          result.failed++;
          result.errors.push(errorText(err));
        }
      }
      finished++;
      run.onProgress?.({ planId, done: finished, total, step });
    }

    plan = await requirePlan(planId);
    const status: PlanStatus = plan.steps.some((s) => s.status === "failed" || s.status === "conflicted" || s.status === "pending") ? "partially_failed" : "executed";
    await store.updatePlan(planId, { status, executedAt: now() });
    result.status = status;
    return result;
  }

  /** Create, approve and execute in one go — a person's click is the approval. */
  async function run(input: Omit<PlanInput, "source" | "actor"> & { source?: PlanSource; actor?: string }, approver: Approver, runOpts?: { onProgress?: (e: ProgressEvent) => void }) {
    const planId = await createPlan({ ...input, source: input.source ?? "user", actor: input.actor ?? `user:${approver.userId}` });
    await approve(planId, approver);
    return execute(planId, runOpts);
  }

  /**
   * After a conflict: "skip" leaves the file alone; "retry" re-plans the step against the file's current
   * version (moves still never overwrite — a taken name gets " (2)"). Call execute() again afterwards.
   */
  async function resolveConflict(planId: Id, seq: number, choice: "skip" | "retry", approver: Approver) {
    const plan = await requirePlan(planId);
    const step = plan.steps.find((s) => s.seq === seq);
    if (!step || (step.status !== "conflicted" && step.status !== "failed")) throw new EngineError("That step has no conflict to resolve.", "invalid_state");
    if (!can(approver.role, "plan", "approve") || !stepAllowed(approver.role, step)) throw new EngineError("Your role can't resolve this step.", "forbidden");
    if (choice === "skip") {
      await store.updateStep(planId, seq, { status: "skipped", error: "Skipped after a conflict." });
    } else {
      const patch: { status: "pending"; error: string; expectVersion?: string } = { status: "pending", error: "" };
      if (step.undoes === undefined && PATH_ACTIONS.has(step.action)) {
        const file = await requireFile(step.fileId);
        const adapter = await opts.adapterFor(plan.spaceId);
        patch.expectVersion = (await adapter.stat(file.ref)).version;
      }
      await store.updateStep(planId, seq, patch);
    }
    const after = await requirePlan(planId);
    if (after.steps.every((s) => s.status === "done" || s.status === "skipped")) await store.updatePlan(planId, { status: "executed" });
    else if (after.steps.some((s) => s.status === "pending")) await store.updatePlan(planId, { status: "approved" });
  }

  async function ensureFolder(adapter: StorageAdapter, dir: string): Promise<FileRef> {
    if (!dir) return ROOT_REF;
    const existing = await adapter.resolve(dir);
    if (existing?.isFolder) return existing.ref;
    if (existing) throw new StorageError(`"${dir}" is a file, not a folder.`, "provider");
    const { dir: parentDir, name } = splitPath(dir);
    const parent = await ensureFolder(adapter, parentDir);
    return (await adapter.createFolder(parent, name)).ref;
  }

  /** Move/rename `entry` to `target` (a full path) through the adapter. */
  async function moveTo(adapter: StorageAdapter, entry: FileEntry, target: string, expectVersion: string): Promise<FileEntry> {
    const to = splitPath(target);
    const from = splitPath(entry.path);
    if (to.dir === from.dir) return adapter.rename(entry.ref, to.name, { expectVersion });
    const parent = await ensureFolder(adapter, to.dir);
    return adapter.move(entry.ref, parent, { expectVersion, ...(to.name !== from.name ? { newName: to.name } : {}) });
  }

  /** Current entry of a file, checked against the version the step was planned with. */
  async function checkedEntry(adapter: StorageAdapter, file: EngineFile, expectVersion: string | undefined): Promise<FileEntry> {
    const entry = await adapter.stat(file.ref).catch((err: unknown) => {
      if (err instanceof StorageError && err.code === "not_found") throw new ConflictError(`"${file.name}" is no longer at ${file.path}. It was moved or removed outside FolderPilot.`);
      throw err;
    });
    if (expectVersion !== undefined && entry.version !== expectVersion) {
      throw new ConflictError(`"${file.name}" changed after this plan was made.`, entry.version);
    }
    return entry;
  }

  async function writable(getAdapter: () => Promise<StorageAdapter>) {
    const adapter = await getAdapter();
    if (adapter.readOnly) throw new ReadOnlyError();
    return adapter;
  }

  async function applyStep(plan: Plan, step: PlanStep, getAdapter: () => Promise<StorageAdapter>): Promise<Outcome> {
    switch (step.action) {
      case "rule_create": {
        const rule = JSON.parse(step.to ?? "{}") as NewRule;
        return {
          commit: async () => {
            const id = await store.createRule({ ...rule, createdAt: now() });
            return { to: String(id), before: step.before ?? "—", after: rule.name };
          },
        };
      }
      case "rule_update": {
        const { id, changes } = JSON.parse(step.to ?? "{}") as { id: Rule["id"]; changes: Partial<Rule> };
        return {
          commit: async () => {
            const old = await store.getRule(id);
            if (!old) throw new EngineError(`Rule ${id} no longer exists.`, "not_found");
            const next = { ...old, ...changes, id: old.id };
            await store.putRule(next);
            return { from: json(old), to: json(next), before: old.name, after: next.name };
          },
        };
      }
      case "createFolder": {
        const path = (step.to ?? "").replace(/^\/+|\/+$/g, "");
        if (!path) throw new EngineError("A new folder needs a name.", "invalid_plan");
        const adapter = await writable(getAdapter);
        if ((await adapter.resolve(path))?.isFolder) throw new Skip(`"${path}" already exists.`);
        await ensureFolder(adapter, path);
        return { commit: async () => ({ to: path, before: "—", after: path }) };
      }
      default:
        break;
    }

    const file = await requireFile(step.fileId);
    switch (step.action) {
      case "move":
      case "rename": {
        if (file.status === "trashed") throw new EngineError(`"${file.name}" is in the Trash.`, "invalid_state");
        const target = step.to ?? file.path;
        if (target === file.path) throw new Skip("Already there.");
        const adapter = await writable(getAdapter);
        let final: FileEntry;
        const expect = step.expectVersion ?? file.version;
        let fromPath = file.path;
        let fromVersion = expect;
        const current = await adapter.stat(file.ref).catch((err: unknown) => (err instanceof StorageError && err.code === "not_found" ? null : Promise.reject(err)));
        if (current === null) {
          // Resuming after a crash between the storage change and the index write: the file is already at the target.
          const moved = await adapter.resolve(target);
          if (!moved || moved.isFolder || moved.version !== expect) {
            throw new ConflictError(`"${file.name}" is no longer at ${file.path}. It was moved or removed outside FolderPilot.`);
          }
          final = moved;
        } else {
          if (expect !== undefined && current.version !== expect) throw new ConflictError(`"${file.name}" changed after this plan was made.`, current.version);
          fromPath = current.path;
          fromVersion = current.version;
          // Already at the target (a resumed run with a provider whose ids survive moves): nothing to do on storage.
          final = current.path === target ? current : await moveTo(adapter, current, target, current.version);
        }
        return {
          commit: async () => {
            await store.updateFile(file.id, {
              ...pathFields(final.path),
              ref: final.ref,
              version: final.version,
              status: file.status === "needs_review" ? "needs_review" : "organized",
            });
            return { from: fromPath, to: final.path, ...(fromVersion !== undefined ? { fromVersion } : {}), toVersion: final.version, before: step.before ?? fromPath, after: final.path };
          },
        };
      }
      case "trash": {
        if (file.status === "trashed") throw new Skip(`"${file.name}" is already in the Trash.`);
        const adapter = await writable(getAdapter);
        const entry = await checkedEntry(adapter, file, step.expectVersion ?? file.version);
        const trashed = await adapter.trash(entry.ref, { expectVersion: entry.version });
        return { commit: () => commitTrash(plan, file, entry, trashed, step.actor ?? plan.actor) };
      }
      case "restore": {
        if (file.status !== "trashed") throw new Skip(`"${file.name}" isn't in the Trash.`);
        const original = (await store.getTrash(file.id))?.originalPath ?? file.trashedFrom;
        if (!original) throw new EngineError(`FolderPilot doesn't know where "${file.name}" came from.`, "invalid_state");
        const adapter = await writable(getAdapter);
        const entry = await checkedEntry(adapter, file, step.expectVersion ?? file.version);
        const restored = await adapter.restore(entry.ref, original);
        return { commit: () => commitRestore(file, entry, restored) };
      }
      case "tag":
      case "untag": {
        const tag = (step.to ?? "").trim().toLowerCase();
        if (!tag) throw new EngineError("Empty tag.", "invalid_plan");
        const next = step.action === "tag" ? [...new Set([...file.tags, tag])] : file.tags.filter((t) => t !== tag);
        return {
          commit: async () => {
            await store.updateFile(file.id, { tags: next });
            return { from: json(file.tags), to: json(next), before: file.tags.join(", ") || "—", after: next.join(", ") || "—" };
          },
        };
      }
      case "caption":
        return {
          commit: async () => {
            await store.updateFile(file.id, { caption: step.to ?? "" });
            return { from: file.caption ?? "", to: step.to ?? "", before: file.caption || "—", after: step.to || "—" };
          },
        };
      case "category": {
        const to = step.to ?? "";
        const source = (step.actor ?? plan.actor).startsWith("rule") ? "rule" : "user";
        return {
          commit: async () => {
            await store.updateFile(file.id, { category: to, categorySource: source, status: file.status === "needs_review" ? "analyzed" : file.status });
            return {
              from: json({ category: file.category ?? null, status: file.status, source: file.categorySource ?? null }),
              to,
              before: file.category || "—",
              after: to,
            };
          },
        };
      }
      case "flag":
      case "unflag": {
        const before = { flags: file.flags, status: file.status, flagReason: file.flagReason ?? null };
        let after: typeof before;
        if (step.to === "review") {
          after = { ...before, status: step.action === "flag" ? "needs_review" : restingStatus(file) };
        } else {
          const flag = step.to as FileFlag;
          const flags = step.action === "flag" ? [...new Set([...file.flags, flag])] : file.flags.filter((f) => f !== flag);
          after = { ...before, flags, flagReason: step.action === "flag" ? (step.after ?? null) : null };
        }
        return {
          commit: async () => {
            await store.updateFile(file.id, { flags: after.flags, status: after.status, flagReason: after.flagReason ?? undefined });
            return { from: json(before), to: json(after), before: step.before ?? "—", after: step.after ?? step.to ?? "—" };
          },
        };
      }
      default:
        throw new EngineError(`Unsupported step "${step.action}".`, "invalid_plan");
    }
  }

  async function commitTrash(plan: Plan, file: EngineFile, entry: FileEntry, trashed: FileEntry, actor: string): Promise<Partial<NewAuditEvent>> {
    const at = now();
    await store.updateFile(file.id, {
      path: trashed.path,
      ref: trashed.ref,
      version: trashed.version,
      status: "trashed",
      trashedFrom: entry.path,
      flags: file.flags.filter((f) => f !== "suggested_delete"),
    });
    await store.putTrash({ fileId: file.id, spaceId: plan.spaceId, originalPath: entry.path, trashedBy: actor, trashedAt: at, purgeAfter: at + retentionMs });
    return { from: entry.path, to: trashed.path, fromVersion: entry.version, toVersion: trashed.version, before: entry.path, after: "Trash" };
  }

  async function commitRestore(file: EngineFile, entry: FileEntry, restored: FileEntry): Promise<Partial<NewAuditEvent>> {
    await store.updateFile(file.id, { ...pathFields(restored.path), ref: restored.ref, version: restored.version, status: restingStatus(file), trashedFrom: undefined });
    await store.clearTrash(file.id);
    return { from: entry.path, to: restored.path, fromVersion: entry.version, toVersion: restored.version, before: "Trash", after: restored.path };
  }

  // ── Undo ──────────────────────────────────────────────────────────────

  async function revertStep(plan: Plan, step: PlanStep, getAdapter: () => Promise<StorageAdapter>, touched: Set<string>): Promise<Outcome> {
    const [event] = await store.getAuditEvents([step.undoes!]);
    if (!event) throw new EngineError("The change to undo is no longer in the audit log.", "not_found");
    if (event.action === "undo") throw new EngineError("An undo can't be undone. Make the change again instead.", "invalid_plan");
    if ((await store.findUndoEvents([event.id])).length > 0) throw new Skip("Already undone.");
    const undoFields = { action: "undo" as const, undoesEventId: event.id, fileIds: event.fileIds, before: event.after, after: event.before };
    const changedSince = (name: string) => new ConflictError(`"${name}" was changed again after this action, so undoing it would overwrite newer changes.`);

    switch (event.action) {
      case "rule_create":
        return {
          commit: async () => {
            await store.removeRule(isNaN(Number(event.to)) ? (event.to ?? "") : Number(event.to));
            return undoFields;
          },
        };
      case "rule_update":
        return {
          commit: async () => {
            if (event.from) await store.putRule(JSON.parse(event.from) as Rule);
            return undoFields;
          },
        };
      case "createFolder":
        // Folders are never removed (that would be a delete); the folder simply stays.
        return { commit: async () => ({ ...undoFields, after: "Folder kept" }) };
      default:
        break;
    }

    const file = await requireFile(event.fileIds[0]);
    // If this undo plan already reverted a later change to the same file, the file now carries that step's version.
    const expected = touched.has(String(file.id)) ? file.version : event.toVersion;
    switch (event.action) {
      case "move":
      case "rename": {
        if (!event.from || !event.to) throw new EngineError("This entry can't be undone (paths missing).", "invalid_state");
        if (file.path !== event.to || file.status === "trashed") throw changedSince(file.name);
        const adapter = await writable(getAdapter);
        const entry = await checkedEntry(adapter, file, expected);
        const back = await moveTo(adapter, entry, event.from, entry.version);
        return {
          commit: async () => {
            await store.updateFile(file.id, { ...pathFields(back.path), ref: back.ref, version: back.version, status: file.status === "organized" ? restingStatus(file) : file.status });
            return { ...undoFields, from: entry.path, to: back.path, fromVersion: entry.version, toVersion: back.version };
          },
        };
      }
      case "trash": {
        if (file.status !== "trashed" || file.path !== event.to) throw changedSince(file.name);
        const adapter = await writable(getAdapter);
        const entry = await checkedEntry(adapter, file, expected);
        const restored = await adapter.restore(entry.ref, event.from ?? file.trashedFrom ?? file.name);
        return { commit: async () => ({ ...(await commitRestore(file, entry, restored)), ...undoFields }) };
      }
      case "restore": {
        if (file.status === "trashed" || file.path !== event.to) throw changedSince(file.name);
        const adapter = await writable(getAdapter);
        const entry = await checkedEntry(adapter, file, expected);
        const trashed = await adapter.trash(entry.ref, { expectVersion: entry.version });
        return { commit: async () => ({ ...(await commitTrash(plan, file, entry, trashed, plan.actor)), ...undoFields }) };
      }
      case "tag":
      case "untag":
        if (json(file.tags) !== event.to) throw changedSince(file.name);
        return {
          commit: async () => {
            await store.updateFile(file.id, { tags: JSON.parse(event.from ?? "[]") as string[] });
            return undoFields;
          },
        };
      case "caption":
        if ((file.caption ?? "") !== (event.to ?? "")) throw changedSince(file.name);
        return {
          commit: async () => {
            await store.updateFile(file.id, { caption: event.from ?? "" });
            return undoFields;
          },
        };
      case "category": {
        if ((file.category ?? "") !== (event.to ?? "")) throw changedSince(file.name);
        const prev = JSON.parse(event.from ?? "{}") as { category: string | null; status: FileStatus; source: EngineFile["categorySource"] | null };
        return {
          commit: async () => {
            await store.updateFile(file.id, { category: prev.category ?? undefined, status: prev.status, categorySource: prev.source ?? undefined });
            return undoFields;
          },
        };
      }
      case "flag":
      case "unflag": {
        const now_ = { flags: file.flags, status: file.status, flagReason: file.flagReason ?? null };
        if (json(now_) !== event.to) throw changedSince(file.name);
        const prev = JSON.parse(event.from ?? "{}") as { flags: FileFlag[]; status: FileStatus; flagReason: string | null };
        return {
          commit: async () => {
            await store.updateFile(file.id, { flags: prev.flags, status: prev.status, flagReason: prev.flagReason ?? undefined });
            return undoFields;
          },
        };
      }
      default:
        throw new EngineError(`"${event.action}" can't be undone.`, "invalid_plan");
    }
  }

  async function eventsFor(target: UndoTarget, spaceId?: Id): Promise<AuditEvent[]> {
    if ("eventIds" in target) return store.getAuditEvents(target.eventIds);
    if ("batchId" in target) return store.findAudit({ batchId: target.batchId, ...(spaceId !== undefined ? { spaceId } : {}) });
    return store.findAudit({ since: target.since, ...(target.actorPrefix ? { actorPrefix: target.actorPrefix } : {}), ...(spaceId !== undefined ? { spaceId } : {}) });
  }

  /** Changes in `target` that can still be undone, newest first. */
  async function undoable(target: UndoTarget, spaceId?: Id): Promise<AuditEvent[]> {
    const events = (await eventsFor(target, spaceId)).filter((e) => e.action !== "undo");
    const undone = new Set((await store.findUndoEvents(events.map((e) => e.id))).map((e) => String(e.undoesEventId)));
    return events.filter((e) => !undone.has(String(e.id))).sort((a, b) => b.seq - a.seq);
  }

  /** Build the inverse plan (pending). Returns null when there's nothing left to undo. */
  async function planUndo(target: UndoTarget, by: { source: PlanSource; actor: string; summary?: string; spaceId?: Id }): Promise<Id | null> {
    const events = await undoable(target, by.spaceId);
    const first = events[0];
    if (!first) return null;
    const spaceIds = new Set(events.map((e) => String(e.spaceId)));
    if (spaceIds.size > 1) throw new EngineError("These changes span several spaces; undo them one space at a time.", "invalid_plan");
    const summary = by.summary ?? `Undo ${events.length === 1 ? "1 change" : `${events.length} changes`}`;
    return createPlan({
      spaceId: first.spaceId,
      source: by.source,
      actor: by.actor,
      summary,
      reason: summary,
      steps: events.map((e) => ({
        action: e.action as StepAction,
        undoes: e.id,
        ...(e.fileIds[0] !== undefined ? { fileId: e.fileIds[0] } : {}),
        ...(e.after !== undefined ? { before: e.after } : {}),
        ...(e.before !== undefined ? { after: e.before } : {}),
      })),
    });
  }

  /** A person clicked Undo: build the inverse plan and run it right away. */
  async function undo(target: UndoTarget, approver: Approver, runOpts?: { spaceId?: Id; summary?: string; onProgress?: (e: ProgressEvent) => void }): Promise<ExecResult> {
    const planId = await planUndo(target, { source: "user", actor: `user:${approver.userId}`, ...(runOpts?.summary ? { summary: runOpts.summary } : {}), ...(runOpts?.spaceId !== undefined ? { spaceId: runOpts.spaceId } : {}) });
    if (planId === null) throw new EngineError("There's nothing left to undo here.", "nothing_to_undo");
    await approve(planId, approver);
    return execute(planId, runOpts?.onProgress ? { onProgress: runOpts.onProgress } : {});
  }

  return { createPlan, keepSteps, cancel, approve, autoApprove, autoApproveSmall, execute, run, resolveConflict, planUndo, undo, undoable };
}

export type Engine = ReturnType<typeof createEngine>;
