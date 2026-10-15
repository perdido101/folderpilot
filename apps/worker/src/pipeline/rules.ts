/**
 * Rule triggers (spec §8):
 * - new/changed files: after analysis (and the AI insight, when the org has AI) a per-space `rules` job runs the
 *   structured rules on files rules haven't seen since their last analysis;
 * - schedule: a tick every 15 minutes runs rules whose schedule is due over their whole scope.
 * Auto rules execute (audited as rule:<id>, undoable); suggest rules become plans waiting for approval.
 */
import { isRuleDue, type RulesJob } from "@folderpilot/core";
import { activeStructuredRules, files, filesNeedingRules, rules, runRulesOnFiles, scoped, spaces, toRule, type RuleRunOutcome } from "@folderpilot/db";
import { and, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { orgProvider, PermanentJobError, type PipelineDeps } from "./processors";

/** Files waiting for their AI insight are left for the run after it (unless the AI is clearly not coming). */
const AI_GRACE_MS = 60 * 60 * 1000;

export async function rulesForSpace(deps: Pick<PipelineDeps, "db" | "encryptionKey" | "hosted" | "adapterFor">, job: RulesJob, now = Date.now()) {
  const { db } = deps;
  const space = await scoped(db, job.orgId).first(spaces, eq(spaces.id, job.spaceId));
  if (!space) throw new PermanentJobError(`Space ${job.spaceId} not found.`);
  const active = await activeStructuredRules(db, job.orgId);
  let todo = await filesNeedingRules(db, job.orgId, space.id);
  const { provider } = await orgProvider(deps as PipelineDeps, job.orgId);
  if (provider) todo = todo.filter((f) => f.aiAnalyzedAt || (f.analyzedAt && now - f.analyzedAt.getTime() > AI_GRACE_MS));
  if (!todo.length) return { files: 0, outcomes: [] as RuleRunOutcome[] };
  if (!active.length) {
    await scoped(db, job.orgId).update(files, inArray(files.id, todo.map((f) => f.id)), { rulesCheckedAt: new Date(now) });
    return { files: todo.length, outcomes: [] as RuleRunOutcome[] };
  }
  const outcomes = await runRulesOnFiles({ db, orgId: job.orgId, space, adapter: deps.adapterFor(space), files: todo, rules: active, markChecked: true, now });
  return { files: todo.length, outcomes };
}

/**
 * The schedule tick: every enabled scheduled rule that is due runs over its whole scope (all files, not only new ones),
 * then records last_run_at. Also queues a rules job for spaces with unchecked files (a safety net for missed triggers).
 */
export async function rulesTick(deps: Pick<PipelineDeps, "db" | "encryptionKey" | "hosted" | "adapterFor"> & { enqueueRules(job: RulesJob): Promise<void> }, now = Date.now()) {
  const { db } = deps;
  // The worker is a trusted system process: it looks across organizations, then scopes every query per org.
  const scheduled = (await db.select().from(rules).where(and(eq(rules.type, "structured"), eq(rules.enabled, true), isNull(rules.archivedAt), ne(rules.schedule, "none")))).filter((r) => isRuleDue(toRule(r), now));
  const ran: { ruleId: string; outcomes: RuleRunOutcome[]; errors: string[] }[] = [];
  for (const row of scheduled) {
    const rule = toRule(row);
    const s = scoped(db, row.organizationId);
    const targets = await s.select(spaces, row.scopeSpaceId ? eq(spaces.id, row.scopeSpaceId) : undefined);
    const result = { ruleId: row.id, outcomes: [] as RuleRunOutcome[], errors: [] as string[] };
    for (const space of targets) {
      try {
        const all = await s.select(files, and(eq(files.spaceId, space.id), sql`${files.status} <> 'trashed'`) as SQL);
        result.outcomes.push(...(await runRulesOnFiles({ db, orgId: row.organizationId, space, adapter: deps.adapterFor(space), files: all, rules: [rule], now })));
      } catch (err) {
        result.errors.push(`${space.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await s.update(rules, eq(rules.id, row.id), { lastRunAt: new Date(now) });
    ran.push(result);
  }

  const unchecked = await db
    .selectDistinct({ orgId: files.organizationId, spaceId: files.spaceId })
    .from(files)
    .where(sql`${files.status} <> 'trashed' and ${files.analyzedAt} is not null and (${files.rulesCheckedAt} is null or ${files.rulesCheckedAt} < greatest(${files.analyzedAt}, coalesce(${files.aiAnalyzedAt}, ${files.analyzedAt})))`);
  for (const u of unchecked) await deps.enqueueRules({ orgId: u.orgId, spaceId: u.spaceId });
  return { scheduled: ran, queued: unchecked.length };
}
