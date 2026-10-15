/**
 * Rules for folders on this device (spec §8), the same way the server runs them:
 * auto rules execute through the engine (audited as rule:<id>, undoable); suggest rules become plans waiting in
 * Pending Approvals. Triggers: new/changed files after indexing + analysis, "Run", and schedules while the app is open.
 */
import { isRuleDue, rulesForFiles, type Rule } from "@folderpilot/core";
import i18n from "@/i18n";
import { db, type FileRecord } from "../db";
import { createPlan, executeAutoRulePlan, type ExecResult } from "../actions/engine";

export interface DeviceRuleOutcome {
  ruleId: Rule["id"];
  ruleName: string;
  mode: "suggest" | "auto";
  planId: number;
  files: number;
  result?: ExecResult;
  error?: string;
}

const fileVersion = (f: Pick<FileRecord, "size" | "mtime">) => `${f.size}-${f.mtime}`;

export const activeRules = async () => (await db.rules.toArray()).filter((r) => r.type === "structured" && r.enabled && !r.archived).sort((a, b) => a.priority - b.priority);

/** File ids already waiting in a pending plan of each rule. */
async function pendingByActor(rootId: number) {
  const pending = await db.plans.where("rootId").equals(rootId).filter((p) => p.status === "pending" && p.source === "rule").toArray();
  const map = new Map<string, Set<number>>();
  for (const p of pending) for (const s of p.steps) if (s.fileId !== undefined) map.set(p.actor, (map.get(p.actor) ?? new Set()).add(s.fileId));
  return map;
}

export async function runRulesOnFiles(rootId: number, files: FileRecord[], rules: Rule[], opts: { markChecked?: boolean } = {}): Promise<DeviceRuleOutcome[]> {
  const pending = await pendingByActor(rootId);
  const outcomes: DeviceRuleOutcome[] = [];
  for (const { rule, mode, steps: all } of rulesForFiles(files, rules)) {
    const actor = `rule:${rule.id}`;
    const waiting = pending.get(actor);
    const steps = waiting ? all.filter((s) => s.fileId === undefined || !waiting.has(s.fileId)) : all;
    if (!steps.length) continue;
    const count = new Set(steps.map((s) => s.fileId)).size;
    const planId = await createPlan({ rootId, source: "rule", actor, summary: i18n.t("actions:summaries.ruleRun", { name: rule.name, count }), reason: rule.name, steps });
    const outcome: DeviceRuleOutcome = { ruleId: rule.id, ruleName: rule.name, mode, planId, files: count };
    if (mode === "auto") {
      try {
        outcome.result = await executeAutoRulePlan(planId);
      } catch (err) {
        outcome.error = err instanceof Error ? err.message : String(err);
      }
    }
    outcomes.push(outcome);
  }
  if (opts.markChecked) {
    await db.transaction("rw", db.files, async () => {
      for (const f of files) await db.files.update(f.id, { rulesChecked: fileVersion(f) });
    });
  }
  return outcomes;
}

/** After indexing and analysis: rules look at new or changed files only. */
export async function runRulesOnNewFiles(rootId: number): Promise<DeviceRuleOutcome[]> {
  const files = await db.files
    .where("rootId")
    .equals(rootId)
    .filter((f) => f.status !== "trashed" && f.rulesChecked !== fileVersion(f))
    .toArray();
  if (!files.length) return [];
  return runRulesOnFiles(rootId, files, await activeRules(), { markChecked: true });
}

/** "Run" / "Run all": every live file of the folder (one rule, even if paused, or all enabled rules). */
export async function runRulesNow(rootId: number, ruleId?: Rule["id"]): Promise<DeviceRuleOutcome[]> {
  const files = await db.files.where("rootId").equals(rootId).filter((f) => f.status !== "trashed").toArray();
  const rules = ruleId === undefined ? await activeRules() : (await db.rules.toArray()).filter((r) => r.id === ruleId && !r.archived).map((r) => ({ ...r, enabled: true }));
  return runRulesOnFiles(rootId, files, rules);
}

/** Scheduled rules that are due run over every folder they apply to, then record lastRunAt. */
export async function runDueScheduledRules(now = Date.now()): Promise<DeviceRuleOutcome[]> {
  const due = (await db.rules.toArray()).filter((r) => r.type === "structured" && isRuleDue(r, now));
  if (!due.length) return [];
  const roots = await db.roots.toArray();
  const outcomes: DeviceRuleOutcome[] = [];
  for (const rule of due) {
    for (const root of roots) {
      if (rule.scopeSpaceId !== undefined && String(rule.scopeSpaceId) !== String(root.id)) continue;
      const files = await db.files.where("rootId").equals(root.id).filter((f) => f.status !== "trashed").toArray();
      outcomes.push(...(await runRulesOnFiles(root.id, files, [rule]).catch(() => [])));
    }
    await db.rules.update(rule.id, { lastRunAt: now });
  }
  return outcomes;
}
