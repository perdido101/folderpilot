/**
 * The action engine: the ONLY code allowed to change files on disk or their organization.
 *
 *   plan (pending) ──Approve──▶ executePlan() ──▶ audit entries (one batch) ──▶ undoBatch()/undoEntry()
 *
 * User-initiated actions (floating action bar, review mode) create a plan that is approved
 * immediately by the user's click. Agent and rule changes stay pending until approved.
 * There is no delete: trashing moves files into .folderpilot-trash and can always be restored.
 */
import { db, type AuditRecord, type FileFlag, type FileRecord, type PlanRecord, type PlanSource, type PlanStep } from "../db";
import { extOf, kindOf } from "../file-kinds";
import type { NewRule, Rule } from "../rules/types";
import { writableRoot } from "../file-access-cache";
import { moveFile, splitPath, trashPathFor } from "./fs-ops";

export interface ExecResult {
  planId: number;
  batchId: string;
  done: number;
  failed: number;
  errors: string[];
  summary: string;
}

const newBatchId = () => `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export interface NewPlan {
  undoBatchId?: string;
  rootId: number;
  source: PlanSource;
  actor: string;
  summary: string;
  reason?: string;
  steps: PlanStep[];
}

export async function createPlan(plan: NewPlan): Promise<number> {
  return db.plans.add({ ...plan, status: "pending", createdAt: Date.now() });
}

export async function cancelPlan(planId: number) {
  await db.plans.update(planId, { status: "cancelled" });
}

/** Remove some steps from a pending plan before approving it ("Edit"). */
export async function updatePlanSteps(planId: number, steps: PlanStep[]) {
  const plan = await db.plans.get(planId);
  if (plan?.status !== "pending") throw new Error("Only pending plans can be edited.");
  await db.plans.update(planId, { steps });
}

/** Human-readable outcome, e.g. "Moved 23 files" or "Tagged 4 files · Renamed 1 file". */
export function describeSteps(steps: Pick<PlanStep, "action">[]): string {
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(s.action, (counts.get(s.action) ?? 0) + 1);
  const verb: Record<string, string> = {
    move: "Moved",
    rename: "Renamed",
    tag: "Tagged",
    untag: "Untagged",
    caption: "Captioned",
    category: "Categorized",
    trash: "Moved to Trash:",
    restore: "Restored",
    flag: "Flagged",
    unflag: "Unflagged",
    rule_create: "Created",
    rule_update: "Updated",
  };
  const parts = [...counts].map(([action, n]) => {
    const noun = action.startsWith("rule") ? (n === 1 ? "rule" : "rules") : n === 1 ? "file" : "files";
    return `${verb[action] ?? action} ${n} ${noun}`;
  });
  return parts.join(" · ") || "Nothing to do";
}

function fileFromPath(path: string): Pick<FileRecord, "path" | "name" | "ext" | "kind"> {
  const { name } = splitPath(path);
  const ext = extOf(name);
  return { path, name, ext, kind: kindOf(ext) };
}

interface Applied {
  from?: string;
  to?: string;
  before?: string;
  after?: string;
}

const json = (v: unknown) => JSON.stringify(v);

async function applyStep(rootId: number, step: PlanStep, getRoot: () => Promise<FileSystemDirectoryHandle>): Promise<Applied> {
  if (step.action === "rule_create") {
    const rule = JSON.parse(step.to ?? "{}") as NewRule;
    const id = await db.rules.add({ ...rule, createdAt: Date.now() });
    return { to: String(id), before: "—", after: rule.name };
  }
  if (step.action === "rule_update") {
    const { id, changes } = JSON.parse(step.to ?? "{}") as { id: number; changes: Partial<Rule> };
    const old = await db.rules.get(id);
    if (!old) throw new Error(`Rule ${id} no longer exists`);
    await db.rules.update(id, changes);
    return { from: json(old), to: json({ ...old, ...changes }), before: old.name, after: changes.name ?? old.name };
  }

  if (step.fileId === undefined) throw new Error("Step has no file");
  const file = await db.files.get(step.fileId);
  if (!file || file.rootId !== rootId) throw new Error(`File #${step.fileId} is not in this folder`);

  switch (step.action) {
    case "move":
    case "rename": {
      if (file.status === "trashed") throw new Error(`${file.name} is in the Trash`);
      const to = step.to ?? file.path;
      const final = await moveFile(await getRoot(), file.path, to);
      await db.files.update(file.id, { ...fileFromPath(final), status: "organized" });
      return { from: file.path, to: final, before: file.path, after: final };
    }
    case "trash": {
      if (file.status === "trashed") throw new Error(`${file.name} is already in the Trash`);
      const final = await moveFile(await getRoot(), file.path, trashPathFor(file.path));
      await db.files.update(file.id, { path: final, status: "trashed", trashedFrom: file.path, flags: file.flags.filter((f) => f !== "suggested_delete") });
      return { from: file.path, to: final, before: file.path, after: "Trash" };
    }
    case "restore": {
      if (file.status !== "trashed" || !file.trashedFrom) throw new Error(`${file.name} is not in the Trash`);
      const final = await moveFile(await getRoot(), file.path, file.trashedFrom);
      await db.files.update(file.id, { ...fileFromPath(final), status: file.category ? "analyzed" : "indexed", trashedFrom: undefined });
      return { from: file.path, to: final, before: "Trash", after: final };
    }
    case "tag":
    case "untag": {
      const tag = (step.to ?? "").trim().toLowerCase();
      const next = step.action === "tag" ? [...new Set([...file.tags, tag])] : file.tags.filter((t) => t !== tag);
      await db.files.update(file.id, { tags: next });
      return { from: json(file.tags), to: json(next), before: file.tags.join(", ") || "—", after: next.join(", ") || "—" };
    }
    case "caption": {
      await db.files.update(file.id, { caption: step.to ?? "" });
      return { from: file.caption ?? "", to: step.to ?? "", before: file.caption || "—", after: step.to || "—" };
    }
    case "category": {
      await db.files.update(file.id, { category: step.to, categorySource: step.actor?.startsWith("rule") ? "rule" : "user", status: file.status === "needs_review" ? "analyzed" : file.status });
      return { from: json({ category: file.category ?? null, status: file.status, source: file.categorySource ?? null }), to: step.to, before: file.category || "—", after: step.to };
    }
    case "flag":
    case "unflag": {
      const before = { flags: file.flags, status: file.status, flagReason: file.flagReason ?? null };
      let after: typeof before;
      if (step.to === "review") {
        after = { ...before, status: step.action === "flag" ? "needs_review" : file.category ? "analyzed" : "indexed" };
      } else {
        const flag = step.to as FileFlag;
        const flags = step.action === "flag" ? [...new Set([...file.flags, flag])] : file.flags.filter((f) => f !== flag);
        after = { ...before, flags, flagReason: step.action === "flag" ? (step.after ?? null) : null };
      }
      await db.files.update(file.id, { flags: after.flags, status: after.status, flagReason: after.flagReason ?? undefined });
      return { from: json(before), to: json(after), before: step.before ?? "—", after: step.after ?? step.to };
    }
  }
}

/** Execute an approved plan. Each step is applied in order; failures don't stop the rest. */
export async function executePlan(planId: number): Promise<ExecResult> {
  const plan = await db.plans.get(planId);
  if (!plan) throw new Error("Plan not found");
  if (plan.status !== "pending" && plan.status !== "approved") throw new Error(`Plan is already ${plan.status}`);
  await db.plans.update(planId, { status: "approved" });

  if (plan.undoBatchId) {
    const u = await undoBatch(plan.undoBatchId);
    await db.plans.update(planId, { status: "executed", executedAt: Date.now(), errors: u.errors });
    return { planId, batchId: "", done: u.undone, failed: u.failed, errors: u.errors, summary: `Undid ${u.undone} change${u.undone === 1 ? "" : "s"}` };
  }

  const batchId = newBatchId();
  let root: FileSystemDirectoryHandle | null = null;
  const getRoot = async () => (root ??= await writableRoot(plan.rootId));
  const errors: string[] = [];
  const doneSteps: PlanStep[] = [];

  for (const step of plan.steps) {
    try {
      const applied = await applyStep(plan.rootId, step, getRoot);
      const entry: Omit<AuditRecord, "id"> = {
        at: Date.now(),
        actor: step.actor ?? plan.actor,
        action: step.action,
        fileIds: step.fileId !== undefined ? [step.fileId] : [],
        ...applied,
        reason: plan.reason ?? plan.summary,
        planId,
        batchId,
        undone: false,
        rootId: plan.rootId,
      };
      await db.audit.add(entry);
      doneSteps.push(step);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  await db.plans.update(planId, { status: "executed", executedAt: Date.now(), batchId, errors });
  return { planId, batchId, done: doneSteps.length, failed: errors.length, errors, summary: describeSteps(doneSteps) };
}

/** Create a plan for a user action and execute it right away (the user's click is the approval). */
export async function runUserAction(rootId: number, summary: string, steps: PlanStep[], reason?: string): Promise<ExecResult> {
  const planId = await createPlan({ rootId, source: "user", actor: "user", summary, reason, steps });
  return executePlan(planId);
}

async function revert(entry: AuditRecord, getRoot: () => Promise<FileSystemDirectoryHandle>) {
  if (entry.action === "rule_create") {
    await db.rules.delete(Number(entry.to));
    return;
  }
  if (entry.action === "rule_update") {
    const old = JSON.parse(entry.from ?? "{}") as Rule;
    await db.rules.put(old);
    return;
  }
  const fileId = entry.fileIds[0];
  const file = fileId !== undefined ? await db.files.get(fileId) : undefined;
  if (!file) throw new Error("File is no longer in the index");

  switch (entry.action) {
    case "move":
    case "rename":
    case "trash":
    case "restore": {
      if (!entry.from || !entry.to) throw new Error("Missing paths");
      if (file.path !== entry.to) throw new Error(`${file.name} has moved since; undo the later change first`);
      const final = await moveFile(await getRoot(), entry.to, entry.from);
      if (entry.action === "trash") {
        await db.files.update(file.id, { ...fileFromPath(final), status: file.category ? "analyzed" : "indexed", trashedFrom: undefined });
      } else if (entry.action === "restore") {
        await db.files.update(file.id, { path: final, status: "trashed", trashedFrom: entry.to });
      } else {
        await db.files.update(file.id, { ...fileFromPath(final), status: file.category ? "analyzed" : "indexed" });
      }
      return;
    }
    case "tag":
    case "untag":
      await db.files.update(file.id, { tags: JSON.parse(entry.from ?? "[]") as string[] });
      return;
    case "caption":
      await db.files.update(file.id, { caption: entry.from ?? "" });
      return;
    case "category": {
      const prev = JSON.parse(entry.from ?? "{}") as { category: string | null; status: FileRecord["status"]; source: FileRecord["categorySource"] | null };
      await db.files.update(file.id, { category: prev.category ?? undefined, status: prev.status, categorySource: prev.source ?? undefined });
      return;
    }
    case "flag":
    case "unflag": {
      const prev = JSON.parse(entry.from ?? "{}") as { flags: FileFlag[]; status: FileRecord["status"]; flagReason: string | null };
      await db.files.update(file.id, { flags: prev.flags, status: prev.status, flagReason: prev.flagReason ?? undefined });
      return;
    }
    case "undo":
      throw new Error("An undo can't be undone; redo the change instead");
  }
}

export interface UndoResult {
  undone: number;
  failed: number;
  errors: string[];
}

async function undoEntries(entries: AuditRecord[], reason: string): Promise<UndoResult> {
  const pending = entries.filter((e) => !e.undone && e.action !== "undo").sort((a, b) => b.id - a.id);
  if (pending.length === 0) return { undone: 0, failed: 0, errors: [] };
  const rootId = pending[0]!.rootId;
  let root: FileSystemDirectoryHandle | null = null;
  const getRoot = async () => (root ??= await writableRoot(rootId));
  const batchId = newBatchId();
  const errors: string[] = [];
  let undone = 0;
  for (const entry of pending) {
    try {
      await revert(entry, getRoot);
      await db.audit.update(entry.id, { undone: true });
      await db.audit.add({
        at: Date.now(),
        actor: "user",
        action: "undo",
        fileIds: entry.fileIds,
        before: entry.after,
        after: entry.before,
        reason: `${reason} (${entry.action})`,
        planId: entry.planId,
        batchId,
        undone: false,
        rootId: entry.rootId,
      });
      undone++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { undone, failed: errors.length, errors };
}

/** Undo every change in a batch (one approved plan), newest first. */
export async function undoBatch(batchId: string): Promise<UndoResult> {
  return undoEntries(await db.audit.where("batchId").equals(batchId).toArray(), `Undo of batch ${batchId}`);
}

/** Undo a single audit entry. */
export async function undoEntry(auditId: number): Promise<UndoResult> {
  const entry = await db.audit.get(auditId);
  return entry ? undoEntries([entry], `Undo of #${auditId}`) : { undone: 0, failed: 0, errors: ["Entry not found"] };
}

export type { PlanRecord };
