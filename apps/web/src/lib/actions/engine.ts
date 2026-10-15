/**
 * The web app's handle on the shared core engine (packages/core) — the ONLY way files or their organization change.
 *
 *   plan (pending) ──Approve──▶ execute ──▶ audit events (one batch) ──▶ undo = inverse plan
 *
 * In this browser ("This device", Private mode) there is one local person, who owns the folder.
 * One-click actions create a plan that the click approves; agent and rule plans wait for Approve.
 * There is no delete: trash moves files into .folderpilot-trash and can always be restored.
 */
import { createEngine, EngineError, type Approver, type ExecResult as CoreExecResult, type StorageAdapter, type UndoTarget } from "@folderpilot/core";
import i18n from "@/i18n";
import { db, type PlanSource, type PlanStep, type StepInput } from "../db";
import { memoryFiles, writableRoot } from "../file-access-cache";
import { LocalBrowserAdapter } from "../storage/local-browser";
import { dexieStore } from "./dexie-store";

/** The person using FolderPilot in this browser. */
export const LOCAL_USER: Approver = { userId: "local", role: "owner" };
export const LOCAL_ACTOR = { user: "user:local", agent: "agent:local" } as const;

async function adapterFor(rootId: number): Promise<StorageAdapter> {
  const root = await db.roots.get(rootId);
  if (root?.readOnly) return new LocalBrowserAdapter({ kind: "memory", files: memoryFiles(rootId) });
  return new LocalBrowserAdapter({ kind: "handle", getRoot: () => writableRoot(rootId) });
}

export const engine = createEngine({ store: dexieStore, adapterFor: (spaceId) => adapterFor(Number(spaceId)) });

export interface ExecResult {
  planId: number;
  batchId: string;
  done: number;
  /** Failed or conflicted steps. */
  failed: number;
  conflicted: number;
  errors: string[];
  summary: string;
}

export interface NewPlan {
  rootId: number;
  source: PlanSource;
  actor: string;
  summary: string;
  reason?: string;
  steps: StepInput[];
}

export async function createPlan(plan: NewPlan): Promise<number> {
  const { rootId, ...rest } = plan;
  return Number(await engine.createPlan({ ...rest, spaceId: rootId }));
}

export async function cancelPlan(planId: number) {
  await engine.cancel(planId);
}

/** Remove some steps from a pending plan before approving it ("Edit"). */
export async function updatePlanSteps(planId: number, keep: Pick<PlanStep, "seq">[]) {
  await engine.keepSteps(
    planId,
    keep.map((s) => s.seq),
  );
}

/** Human-readable outcome, e.g. "Moved 23 files" or "Tagged 4 files · Renamed 1 file". */
export function describeSteps(steps: Pick<PlanStep, "action" | "undoes">[]): string {
  const counts = new Map<string, number>();
  for (const s of steps) {
    const key = s.undoes !== undefined ? "undo" : s.action;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts].map(([action, count]) => i18n.t(`actions:steps.${action as PlanStep["action"]}`, { count }));
  return parts.join(" · ") || i18n.t("actions:steps.none");
}

function toResult(r: CoreExecResult, undo = false): ExecResult {
  return {
    planId: Number(r.planId),
    batchId: r.batchId,
    done: r.done,
    failed: r.failed + r.conflicted,
    conflicted: r.conflicted,
    errors: r.errors,
    summary: undo ? i18n.t("actions:steps.undo", { count: r.done }) : describeSteps(r.doneActions.map((action) => ({ action }))),
  };
}

/** Approve (if still pending) and execute a plan. Resumes a partly executed plan. */
export async function executePlan(planId: number): Promise<ExecResult> {
  const plan = await db.plans.get(planId);
  if (plan?.status === "pending") await engine.approve(planId, LOCAL_USER);
  return toResult(await engine.execute(planId), plan?.steps.some((s) => s.undoes !== undefined));
}

/** Run a plan from a rule set to "auto" (the engine refuses anything else). Still audited as rule:<id> and undoable. */
export async function executeAutoRulePlan(planId: number): Promise<ExecResult> {
  await engine.autoApprove(planId);
  return toResult(await engine.execute(planId));
}

/** Create a plan for a person's action and execute it right away (the click is the approval). */
export async function runUserAction(rootId: number, summary: string, steps: NewPlan["steps"], reason?: string): Promise<ExecResult> {
  return toResult(await engine.run({ spaceId: rootId, summary, steps, ...(reason ? { reason } : {}) }, LOCAL_USER));
}

/** After a conflict: skip the step, or apply it to the file as it is now. Then finish the plan. */
export async function resolveConflict(planId: number, seq: number, choice: "skip" | "retry"): Promise<ExecResult | null> {
  await engine.resolveConflict(planId, seq, choice, LOCAL_USER);
  const plan = await db.plans.get(planId);
  return plan?.status === "approved" ? executePlan(planId) : null;
}

export interface UndoResult {
  undone: number;
  failed: number;
  errors: string[];
}

async function runUndo(target: UndoTarget, rootId?: number): Promise<UndoResult> {
  try {
    const r = await engine.undo(target, LOCAL_USER, rootId !== undefined ? { spaceId: rootId } : undefined);
    return { undone: r.done, failed: r.failed + r.conflicted, errors: r.errors };
  } catch (err) {
    if (err instanceof EngineError && err.code === "nothing_to_undo") return { undone: 0, failed: 0, errors: [] };
    return { undone: 0, failed: 1, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/** Undo every change in a batch (one executed plan), newest first. */
export const undoBatch = (batchId: string) => runUndo({ batchId });

/** Undo a single audit entry. */
export const undoEntry = (auditId: number) => runUndo({ eventIds: [auditId] });

/** Undo everything the agent did in this folder since a moment in time. */
export const undoAgentSince = (rootId: number, since: number) => runUndo({ since, actorPrefix: "agent" }, rootId);

/** The agent's undo tool: an inverse plan that waits for Approve. */
export async function proposeUndo(rootId: number, batchId: string): Promise<number | null> {
  const id = await engine.planUndo({ batchId }, { source: "agent", actor: LOCAL_ACTOR.agent, spaceId: rootId });
  return id === null ? null : Number(id);
}
