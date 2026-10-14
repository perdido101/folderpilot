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
import { extOf, kindOf } from "@folderpilot/core";
import type { NewRule, Rule } from "@folderpilot/core";
import { writableRoot } from "../file-access-cache";
import i18n from "@/i18n";
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
  if (plan?.status !== "pending") throw new Error(i18n.t("actions:errors.onlyPendingEditable"));
  await db.plans.update(planId, { steps });
}

/** Human-readable outcome, e.g. "Moved 23 files" or "Tagged 4 files · Renamed 1 file". */
export function describeSteps(steps: Pick<PlanStep, "action">[]): string {
  const counts = new Map<PlanStep["action"], number>();
  for (const s of steps) counts.set(s.action, (counts.get(s.action) ?? 0) + 1);
  const parts = [...counts].map(([action, count]) => i18n.t(`actions:steps.${action}`, { count }));
  return parts.join(" · ") || i18n.t("actions:steps.none");
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
    if (!old) throw new Error(i18n.t("actions:errors.ruleGone", { id }));
    await db.rules.update(id, changes);
    return { from: json(old), to: json({ ...old, ...changes }), before: old.name, after: changes.name ?? old.name };
  }

  if (step.fileId === undefined) throw new Error(i18n.t("actions:errors.stepNoFile"));
  const file = await db.files.get(step.fileId);
  if (!file || file.rootId !== rootId) throw new Error(i18n.t("actions:errors.fileNotInFolder", { id: step.fileId }));

  switch (step.action) {
    case "move":
    case "rename": {
      if (file.status === "trashed") throw new Error(i18n.t("actions:errors.inTrash", { name: file.name }));
      const to = step.to ?? file.path;
      const final = await moveFile(await getRoot(), file.path, to);
      await db.files.update(file.id, { ...fileFromPath(final), status: "organized" });
      return { from: file.path, to: final, before: file.path, after: final };
    }
    case "createFolder":
      // Folders are created implicitly by moves in the local index; explicit folder steps arrive with the storage adapters.
      throw new Error(i18n.t("actions:errors.createFolderUnsupported"));
    case "trash": {
      if (file.status === "trashed") throw new Error(i18n.t("actions:errors.alreadyInTrash", { name: file.name }));
      const final = await moveFile(await getRoot(), file.path, trashPathFor(file.path));
      await db.files.update(file.id, { path: final, status: "trashed", trashedFrom: file.path, flags: file.flags.filter((f) => f !== "suggested_delete") });
      return { from: file.path, to: final, before: file.path, after: i18n.t("actions:labels.trash") };
    }
    case "restore": {
      if (file.status !== "trashed" || !file.trashedFrom) throw new Error(i18n.t("actions:errors.notInTrash", { name: file.name }));
      const final = await moveFile(await getRoot(), file.path, file.trashedFrom);
      await db.files.update(file.id, { ...fileFromPath(final), status: file.category ? "analyzed" : "indexed", trashedFrom: undefined });
      return { from: file.path, to: final, before: i18n.t("actions:labels.trash"), after: final };
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
      await db.files.update(file.id, {
        category: step.to,
        categorySource: step.actor?.startsWith("rule") ? "rule" : "user",
        status: file.status === "needs_review" ? "analyzed" : file.status,
      });
      return {
        from: json({ category: file.category ?? null, status: file.status, source: file.categorySource ?? null }),
        to: step.to,
        before: file.category || "—",
        after: step.to,
      };
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
  if (!plan) throw new Error(i18n.t("actions:errors.planNotFound"));
  if (plan.status !== "pending" && plan.status !== "approved")
    throw new Error(i18n.t("actions:errors.planAlready", { status: i18n.t(`plans:status.${plan.status}`) }));
  await db.plans.update(planId, { status: "approved" });

  if (plan.undoBatchId) {
    const u = await undoBatch(plan.undoBatchId);
    await db.plans.update(planId, { status: "executed", executedAt: Date.now(), errors: u.errors });
    return { planId, batchId: "", done: u.undone, failed: u.failed, errors: u.errors, summary: i18n.t("actions:steps.undo", { count: u.undone }) };
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
  if (!file) throw new Error(i18n.t("actions:errors.fileGone"));

  switch (entry.action) {
    case "move":
    case "rename":
    case "trash":
    case "restore": {
      if (!entry.from || !entry.to) throw new Error(i18n.t("actions:errors.missingPaths"));
      if (file.path !== entry.to) throw new Error(i18n.t("actions:errors.movedSince", { name: file.name }));
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
      throw new Error(i18n.t("actions:errors.undoOfUndo"));
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
  return undoEntries(await db.audit.where("batchId").equals(batchId).toArray(), i18n.t("actions:summaries.undoBatch", { id: batchId }));
}

/** Undo a single audit entry. */
export async function undoEntry(auditId: number): Promise<UndoResult> {
  const entry = await db.audit.get(auditId);
  return entry
    ? undoEntries([entry], i18n.t("actions:summaries.undoEntry", { id: auditId }))
    : { undone: 0, failed: 0, errors: [i18n.t("actions:errors.entryNotFound")] };
}

export type { PlanRecord };
