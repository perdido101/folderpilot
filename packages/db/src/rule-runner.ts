/**
 * Runs structured rules over files of one space (spec §8), shared by the API ("Run on folder") and the worker
 * (new/changed files, schedules). Auto rules execute through the engine (audited as rule:<id>, undoable);
 * suggest rules become pending plans for a person. Files already waiting in a pending plan of the same rule are skipped.
 */
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { createEngine, EngineError, rulesForFiles, type ExecResult, type Rule, type StorageAdapter } from "@folderpilot/core";
import type { Database } from "./client";
import { createPgEngineStore, toEngineFile, toRule } from "./engine-store";
import { scoped } from "./scoped";
import { files, plans, planSteps, rules, spaces } from "./schema";

type FileRow = typeof files.$inferSelect;
type SpaceRow = typeof spaces.$inferSelect;

export interface RuleRunOutcome {
  ruleId: string;
  ruleName: string;
  mode: "suggest" | "auto";
  planId: string;
  files: number;
  /** Auto rules only. */
  result?: Pick<ExecResult, "status" | "done" | "failed" | "conflicted" | "errors">;
  error?: string;
}

/** Enabled, non-archived structured rules of the organization, in priority order. */
export async function activeStructuredRules(db: Database, orgId: string): Promise<Rule[]> {
  const rows = await scoped(db, orgId).select(rules, and(eq(rules.type, "structured"), eq(rules.enabled, true), isNull(rules.archivedAt)) as SQL);
  return rows.map(toRule).sort((a, b) => a.priority - b.priority);
}

/** File ids already waiting in a pending plan of each rule, per actor ("rule:<id>"). */
async function pendingFilesByActor(db: Database, orgId: string, spaceId: string): Promise<Map<string, Set<string>>> {
  const rows = await db
    .select({ actor: plans.actor, fileId: planSteps.fileId })
    .from(planSteps)
    .innerJoin(plans, eq(plans.id, planSteps.planId))
    .where(and(eq(plans.organizationId, orgId), eq(plans.spaceId, spaceId), eq(plans.source, "rule"), eq(plans.status, "pending")));
  const map = new Map<string, Set<string>>();
  for (const r of rows) if (r.fileId) map.set(r.actor, (map.get(r.actor) ?? new Set()).add(r.fileId));
  return map;
}

const plural = (n: number) => (n === 1 ? "1 file" : `${n} files`);

export async function runRulesOnFiles(opts: {
  db: Database;
  orgId: string;
  space: SpaceRow;
  adapter: StorageAdapter;
  files: FileRow[];
  rules: Rule[];
  /** Record that rules looked at these files (worker: only new/changed files are checked next time). */
  markChecked?: boolean;
  now?: number;
}): Promise<RuleRunOutcome[]> {
  const { db, orgId, space, adapter } = opts;
  const now = opts.now ?? Date.now();
  const engine = createEngine({ store: createPgEngineStore(db, orgId), adapterFor: async () => adapter });
  const pending = await pendingFilesByActor(db, orgId, space.id);
  const outcomes: RuleRunOutcome[] = [];

  for (const { rule, mode, steps: all } of rulesForFiles(opts.files.map(toEngineFile), opts.rules, now)) {
    const actor = `rule:${rule.id}`;
    const waiting = pending.get(actor);
    const steps = waiting ? all.filter((s) => s.fileId === undefined || !waiting.has(String(s.fileId))) : all;
    if (!steps.length) continue;
    const fileCount = new Set(steps.map((s) => String(s.fileId))).size;
    const planId = String(await engine.createPlan({ spaceId: space.id, source: "rule", actor, summary: `${rule.name}: ${plural(fileCount)}`, reason: `Rule "${rule.name}"`, steps }));
    const outcome: RuleRunOutcome = { ruleId: String(rule.id), ruleName: rule.name, mode, planId, files: fileCount };
    if (mode === "auto") {
      try {
        await engine.autoApprove(planId);
        const r = await engine.execute(planId);
        outcome.result = { status: r.status, done: r.done, failed: r.failed, conflicted: r.conflicted, errors: r.errors };
      } catch (err) {
        if (!(err instanceof EngineError)) throw err;
        outcome.error = err.message;
      }
    }
    outcomes.push(outcome);
  }

  if (opts.markChecked && opts.files.length) {
    await scoped(db, orgId).update(files, inArray(files.id, opts.files.map((f) => f.id)), { rulesCheckedAt: new Date(now) });
  }
  return outcomes;
}

/** Files of a space that rules haven't looked at since their last analysis (new or changed). */
export async function filesNeedingRules(db: Database, orgId: string, spaceId: string): Promise<FileRow[]> {
  return scoped(db, orgId).select(
    files,
    and(
      eq(files.spaceId, spaceId),
      sql`${files.status} <> 'trashed'`,
      sql`${files.analyzedAt} is not null`,
      sql`(${files.rulesCheckedAt} is null or ${files.rulesCheckedAt} < greatest(${files.analyzedAt}, coalesce(${files.aiAnalyzedAt}, ${files.analyzedAt})))`,
    ) as SQL,
  );
}
