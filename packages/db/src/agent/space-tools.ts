/**
 * The agent's tools for a server space (Postgres). Shared by the FolderPilot chat and, in phase 10, the MCP server.
 * Every query is scoped to the organization and the space; every change is a plan through the engine (pending unless
 * the organization's auto-run setting allows a small agent plan). There is no delete, trash or approve tool.
 */
import { and, asc, count, desc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { asFilter, asInt, asText, type AgentToolRunner, type FileFilter, type StatGroup, type ToolOutcome, STAT_GROUPS, PLAN_ACTIONS } from "@folderpilot/ai";
import {
  can,
  cleanFolderPath,
  createEngine,
  dryRun,
  EngineError,
  extsOfKind,
  KNOWN_EXTS,
  kindOf,
  matchesRule,
  ruleProblem,
  sanitizeSuggestedName,
  type AutoRunSettings,
  type Condition,
  type FileKind,
  type NewRule,
  type ProposedStep,
  type Role,
  type Rule,
  type RuleAction,
  type StorageAdapter,
  type Thresholds,
} from "@folderpilot/core";
import type { Database } from "../client";
import { createPgEngineStore, toEngineFile, toRule } from "../engine-store";
import { activeStructuredRules } from "../rule-runner";
import { scoped } from "../scoped";
import { files, plans, planSteps, rules, spaces } from "../schema";

type FileRow = typeof files.$inferSelect;

export interface SpaceAgentContext {
  db: Database;
  orgId: string;
  userId: string;
  role: Role;
  space: typeof spaces.$inferSelect;
  adapter: () => StorageAdapter;
  autoRun: AutoRunSettings;
  thresholds: Thresholds;
  /** Audit actor; the FolderPilot chat uses agent:<userId>, MCP uses mcp:<client>:<userId>. */
  actor?: string;
  source?: "agent" | "mcp";
}

export class AgentToolError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const like = (s: string) => `%${s.replace(/[%_\\]/g, "\\$&")}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const STOPWORDS = new Set(["the", "a", "an", "of", "for", "and", "or", "in", "on", "to", "from", "with", "my", "our", "all", "files", "file", "find", "show", "me", "please"]);

/** What the model sees of a file (no provider internals, no full text). */
function compact(f: FileRow) {
  return {
    id: f.id,
    name: f.name,
    path: f.path,
    category: f.category ?? undefined,
    client: f.entities?.client,
    docType: f.entities?.docType,
    size: f.size,
    modified: f.mtime ? f.mtime.toISOString().slice(0, 10) : undefined,
    flags: f.flags.length ? f.flags : undefined,
    tags: f.tags.length ? f.tags : undefined,
    status: f.status,
  };
}

function filterSql(f: FileFilter): SQL[] {
  const out: SQL[] = [];
  out.push(f.status ? sql`${files.status} = ${f.status}` : sql`${files.status} <> 'trashed'`);
  if (f.folder) out.push(sql`(${files.path} ilike ${`${f.folder.replace(/[%_\\]/g, "\\$&")}/%`})`);
  if (f.category) out.push(ilike(files.category, f.category));
  if (f.ext) out.push(eq(files.ext, f.ext));
  if (f.flag) out.push(sql`${f.flag} = any(${files.flags})`);
  if (f.client) out.push(sql`(${files.entities}->>'client') ilike ${like(f.client)}`);
  if (f.kind) {
    const exts = extsOfKind(f.kind as FileKind);
    out.push(exts.length ? inArray(files.ext, [...exts]) : sql`not (${files.ext} = any(${KNOWN_EXTS as string[]}))`);
  }
  if (f.modifiedAfter && !Number.isNaN(Date.parse(f.modifiedAfter))) out.push(sql`${files.mtime} >= ${new Date(f.modifiedAfter)}`);
  if (f.modifiedBefore && !Number.isNaN(Date.parse(f.modifiedBefore))) out.push(sql`${files.mtime} < ${new Date(f.modifiedBefore)}`);
  return out;
}

const STAT_EXPR: Record<Exclude<StatGroup, "kind" | "flag">, SQL> = {
  category: sql`coalesce(${files.category}, 'uncategorized')`,
  ext: sql`coalesce(nullif(${files.ext}, ''), '(none)')`,
  status: sql`${files.status}::text`,
  client: sql`coalesce(${files.entities}->>'client', '(none)')`,
  docType: sql`coalesce(${files.entities}->>'docType', '(none)')`,
  folder: sql`case when position('/' in ${files.path}) > 0 then split_part(${files.path}, '/', 1) else '(top level)' end`,
  year: sql`coalesce(to_char(${files.mtime}, 'YYYY'), '(unknown)')`,
  month: sql`coalesce(to_char(${files.mtime}, 'YYYY-MM'), '(unknown)')`,
};

export function createSpaceTools(ctx: SpaceAgentContext): AgentToolRunner {
  const { db, orgId, space } = ctx;
  const s = scoped(db, orgId);
  const actor = ctx.actor ?? `agent:${ctx.userId}`;
  const source = ctx.source ?? "agent";
  const engine = createEngine({ store: createPgEngineStore(db, orgId), adapterFor: async () => ctx.adapter() });
  const inSpace = (...conds: (SQL | undefined)[]) => s.where(files, and(eq(files.spaceId, space.id), ...conds) as SQL);

  const need = (ok: boolean, what: string) => {
    if (!ok) throw new AgentToolError(`The person you're helping can't ${what} (their role is ${ctx.role}).`);
  };

  async function fileOr(idValue: unknown): Promise<FileRow> {
    const id = asText(idValue);
    const row = UUID.test(id) ? (await db.select().from(files).where(inSpace(eq(files.id, id))).limit(1))[0] : undefined;
    if (!row) throw new AgentToolError(`File ${id || "(none)"} is not in this space.`);
    return row;
  }

  /** Create the plan; run it at once only when the admin allows small agent plans. */
  async function propose(summary: string, steps: (ProposedStep & { expectVersion?: string })[], reason?: string): Promise<{ planId: string; status: string; ran?: { done: number; failed: number } }> {
    const planId = String(await engine.createPlan({ spaceId: space.id, source, actor, summary, ...(reason ? { reason } : {}), steps }));
    if (await engine.autoApproveSmall(planId, ctx.autoRun)) {
      const r = await engine.execute(planId);
      return { planId, status: r.status, ran: { done: r.done, failed: r.failed + r.conflicted } };
    }
    return { planId, status: "pending_approval" };
  }

  const describePlan = (p: { status: string; ran?: { done: number } }) => (p.status === "pending_approval" ? "Plan waiting for approval" : `Ran automatically (${plural(p.ran?.done ?? 0, "change")})`);

  const handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolOutcome>> = {
    async search_files(input) {
      need(can(ctx.role, "file", "view"), "view files");
      const query = asText(input.query).toLowerCase();
      const terms = query
        .split(/[^\p{L}\p{N}._-]+/u)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t))
        .slice(0, 8);
      const haystack = sql`concat_ws(' ', ${files.name}, ${files.path}, ${files.caption}, ${files.category}, array_to_string(${files.tags}, ' '), ${files.textExcerpt}, ${files.entities}::text, to_char(${files.mtime}, 'YYYY'))`;
      const conds = [...filterSql(asFilter(input.filters)), ...terms.map((t) => sql`${haystack} ilike ${like(t)}`)];
      const limit = asInt(input.limit, 20, 100);
      const nameHit = terms[0] ? sql`(${files.name} ilike ${like(terms[0])})` : sql`false`;
      const rows = await db.select().from(files).where(inSpace(...conds)).orderBy(desc(nameHit), desc(files.mtime)).limit(limit);
      const [total] = await db.select({ n: count() }).from(files).where(inSpace(...conds));
      return {
        result: { total: total?.n ?? 0, files: rows.map((f) => ({ ...compact(f), caption: f.caption ?? undefined })) },
        summary: `Found ${plural(total?.n ?? 0, "file")}`,
        fileIds: rows.slice(0, 30).map((f) => f.id),
      };
    },

    async list_files(input) {
      need(can(ctx.role, "file", "view"), "view files");
      const conds = filterSql(asFilter(input));
      const limit = asInt(input.limit, 50, 200);
      const rows = await db.select().from(files).where(inSpace(...conds)).orderBy(asc(files.path)).limit(limit).offset(asInt(input.offset, 0));
      const [total] = await db.select({ n: count() }).from(files).where(inSpace(...conds));
      return { result: { total: total?.n ?? 0, files: rows.map(compact) }, summary: `Listed ${plural(rows.length, "file")} of ${total?.n ?? 0}`, fileIds: rows.slice(0, 30).map((f) => f.id) };
    },

    async get_file(input) {
      need(can(ctx.role, "file", "view"), "view files");
      const f = await fileOr(input.id);
      return {
        result: { ...compact(f), caption: f.caption, suggestedName: f.suggestedName, entities: f.entities, confidence: f.confidence, width: f.width, height: f.height, exif: f.exif, textExcerpt: f.textExcerpt?.slice(0, 800) },
        summary: f.name,
        fileIds: [f.id],
      };
    },

    async explain_categorization(input) {
      need(can(ctx.role, "file", "view"), "view files");
      const f = await fileOr(input.fileId);
      const indexed = toEngineFile(f);
      const matching = (await activeStructuredRules(db, orgId)).filter((r) => matchesRule(indexed, r)).map((r) => ({ name: r.name, mode: r.mode ?? "suggest" }));
      const t = ctx.thresholds;
      return {
        result: {
          name: f.name,
          category: f.category ?? "not analyzed yet",
          categorySetBy: f.categorySource ?? null,
          aiReason: f.aiReason ?? null,
          confidence: f.confidence ?? null,
          needsReview: f.status === "needs_review" ? `AI confidence below ${t.confidence}` : false,
          matchingRules: matching,
          flags: f.flags,
          flagReason: f.flagReason ?? null,
          analysis: {
            blurScore: f.blurScore !== null ? `${f.blurScore} (blurry below ${t.blur})` : undefined,
            brightness: f.brightness !== null ? `${f.brightness} (dark below ${t.dark})` : undefined,
            size: f.width ? `${f.width}×${f.height} (tiny below ${t.tiny}px)` : undefined,
          },
        },
        summary: `Explained ${f.name}`,
        fileIds: [f.id],
      };
    },

    async propose_plan(input) {
      need(can(ctx.role, "plan", "propose"), "propose changes");
      const raw = Array.isArray(input.steps) ? (input.steps as Record<string, unknown>[]) : [];
      if (!raw.length) throw new AgentToolError("A plan needs at least one step.");
      if (raw.length > 500) throw new AgentToolError("Plans are limited to 500 steps; split the work.");
      const steps: ProposedStep[] = [];
      for (const r of raw) {
        const f = await fileOr(r.fileId);
        if (f.status === "trashed") throw new AgentToolError(`${f.name} is in the Trash.`);
        const action = asText(r.action);
        const to = asText(r.to).trim();
        if (!(PLAN_ACTIONS as readonly string[]).includes(action)) throw new AgentToolError(`Unsupported action "${action}". There is no delete; use flag_for_deletion.`);
        if (action === "move") {
          const folder = cleanFolderPath(to);
          const dest = folder ? `${folder}/${f.name}` : f.name;
          if (dest !== f.path) steps.push({ fileId: f.id, action: "move", from: f.path, to: dest, before: f.path, after: dest });
        } else if (action === "rename") {
          const name = sanitizeSuggestedName(to, f.name);
          const dest = folderOf(f.path) ? `${folderOf(f.path)}/${name}` : name;
          if (dest !== f.path) steps.push({ fileId: f.id, action: "rename", from: f.path, to: dest, before: f.name, after: name });
        } else if (action === "tag" || action === "untag") {
          const tag = to.toLowerCase();
          if (!tag) continue;
          const has = f.tags.includes(tag);
          if ((action === "tag" && has) || (action === "untag" && !has)) continue;
          steps.push({ fileId: f.id, action, to: tag, before: f.tags.join(", ") || "—", after: action === "tag" ? [...f.tags, tag].join(", ") : f.tags.filter((t) => t !== tag).join(", ") || "—" });
        } else if (action === "caption") {
          steps.push({ fileId: f.id, action: "caption", from: f.caption ?? "", to, before: f.caption || "—", after: to });
        } else if (to && to !== f.category) {
          steps.push({ fileId: f.id, action: "category", from: f.category ?? "", to, before: f.category || "—", after: to });
        }
      }
      if (!steps.length) return { result: { status: "nothing_to_do", note: "Every file is already the way the plan wants it." }, summary: "Nothing to change" };
      const p = await propose(asText(input.summary).slice(0, 200) || "Agent plan", steps, asText(input.reason).slice(0, 500) || undefined);
      return {
        result: { ...p, changes: steps.length, note: p.status === "pending_approval" ? "Shown to the person as a Plan Card. Nothing changes until it is approved." : "Ran automatically under the admin's auto-run setting." },
        summary: describePlan(p),
        planIds: [p.planId],
      };
    },

    async propose_rule(input) {
      need(can(ctx.role, "rule", "manage"), "manage rules");
      const rule = ruleFromInput(input, (await activeStructuredRules(db, orgId)).length + 1);
      const problem = ruleProblem(rule);
      if (problem) throw new AgentToolError(problem);
      const live = await s.select(files, and(eq(files.spaceId, space.id), sql`${files.status} <> 'trashed'`) as SQL);
      const { matches } = dryRun(live.map(toEngineFile), { ...rule, id: "preview" });
      const planId = String(
        await engine.createPlan({ spaceId: space.id, source, actor, summary: `Create rule “${rule.name}”`, reason: `Would match ${plural(matches.length, "file")} in ${space.name} right now`, steps: [{ action: "rule_create", to: JSON.stringify(rule), before: "—", after: rule.name }] }),
      );
      return { result: { planId, status: "pending_approval", wouldMatchNow: matches.length, mode: "suggest" }, summary: `Rule proposal (matches ${matches.length} now)`, planIds: [planId] };
    },

    async update_rule_proposal(input) {
      need(can(ctx.role, "rule", "manage"), "manage rules");
      const changes = (input.changes ?? {}) as Record<string, unknown>;
      const planIdIn = asText(input.planId);
      if (planIdIn) {
        // Revise an earlier proposal that is still waiting: withdraw it and propose the revised rule.
        const plan = UUID.test(planIdIn) ? await s.first(plans, and(eq(plans.id, planIdIn), eq(plans.spaceId, space.id), eq(plans.status, "pending")) as SQL) : undefined;
        const [step] = plan ? await db.select().from(planSteps).where(and(eq(planSteps.planId, plan.id), eq(planSteps.action, "rule_create"))) : [];
        if (!plan || !step) throw new AgentToolError(`Plan ${planIdIn} isn't a rule proposal waiting for approval.`);
        const old = JSON.parse(step.toValue ?? "{}") as NewRule;
        const next = { ...old, ...ruleChanges(changes, old) };
        const problem = ruleProblem(next);
        if (problem) throw new AgentToolError(problem);
        await engine.cancel(plan.id);
        const planId = String(await engine.createPlan({ spaceId: space.id, source, actor, summary: `Create rule “${next.name}”`, reason: "Revised proposal", steps: [{ action: "rule_create", to: JSON.stringify(next), before: "—", after: next.name }] }));
        return { result: { planId, replaces: plan.id, status: "pending_approval" }, summary: "Revised rule proposal", planIds: [planId] };
      }
      const ruleId = asText(input.ruleId);
      const row = UUID.test(ruleId) ? await s.first(rules, eq(rules.id, ruleId)) : undefined;
      if (!row || row.archivedAt) throw new AgentToolError(`Rule ${ruleId || "(none)"} not found.`);
      const old = toRule(row);
      const patch = ruleChanges(changes, old);
      if ("mode" in changes && changes.mode === "auto") throw new AgentToolError("Only an admin can make a rule run automatically; the agent can't.");
      const problem = ruleProblem({ ...old, ...patch });
      if (problem) throw new AgentToolError(problem);
      const planId = String(
        await engine.createPlan({ spaceId: space.id, source, actor, summary: `Update rule “${old.name}”`, steps: [{ action: "rule_update", to: JSON.stringify({ id: old.id, changes: patch }), before: old.name, after: Object.keys(patch).join(", ") || "no changes" }] }),
      );
      return { result: { planId, status: "pending_approval" }, summary: "Rule change waiting for approval", planIds: [planId] };
    },

    async flag_for_deletion(input) {
      need(can(ctx.role, "plan", "propose"), "propose changes");
      const ids = Array.isArray(input.fileIds) ? input.fileIds.slice(0, 500) : [];
      const reason = asText(input.reason).slice(0, 300) || "Suggested by the agent";
      const steps: ProposedStep[] = [];
      for (const id of ids) {
        const f = await fileOr(id);
        if (!f.flags.includes("suggested_delete") && f.status !== "trashed") steps.push({ fileId: f.id, action: "flag", to: "suggested_delete", before: "—", after: `Suggested for deletion: ${reason}` });
      }
      if (!steps.length) return { result: { flagged: 0, note: "Those files are already flagged (or in the Trash)." }, summary: "Nothing to flag" };
      const p = await propose(`Suggest ${plural(steps.length, "file")} for deletion`, steps, reason);
      return {
        result: { ...p, files: steps.length, note: "This only flags files for review; nothing is deleted or trashed. A person decides in Needs Review." },
        summary: describePlan(p),
        planIds: [p.planId],
        fileIds: steps.map((x) => String(x.fileId)),
      };
    },

    async propose_undo(input) {
      need(can(ctx.role, "plan", "propose"), "propose changes");
      const batchId = asText(input.batchId);
      const since = Date.parse(asText(input.since));
      const target = batchId ? { batchId } : !Number.isNaN(since) ? { since, actorPrefix: "agent" } : null;
      if (!target) throw new AgentToolError("Pass a batchId (from get_audit) or a 'since' time.");
      let planId;
      try {
        planId = await engine.planUndo(target, { source, actor, spaceId: space.id });
      } catch (err) {
        if (err instanceof EngineError) throw new AgentToolError(err.message);
        throw err;
      }
      if (planId === null) throw new AgentToolError("There's nothing left to undo there.");
      return { result: { planId: String(planId), status: "pending_approval" }, summary: "Undo waiting for approval", planIds: [String(planId)] };
    },

    async get_audit(input) {
      need(can(ctx.role, "audit", "view"), "view the audit log");
      const conds: SQL[] = [sql`organization_id = ${orgId}`, sql`space_id = ${space.id}`];
      const actorIn = asText(input.actor).trim();
      if (actorIn) conds.push(sql`actor like ${`${actorIn.replace(/[%_\\]/g, "\\$&")}%`}`);
      const action = asText(input.action).trim();
      if (action) conds.push(sql`action = ${action}`);
      const fileId = asText(input.fileId);
      if (UUID.test(fileId)) conds.push(sql`${fileId}::uuid = any(file_ids)`);
      const sinceMs = Date.parse(asText(input.since));
      if (!Number.isNaN(sinceMs)) conds.push(sql`at >= ${new Date(sinceMs)}`);
      const untilMs = Date.parse(asText(input.until));
      if (!Number.isNaN(untilMs)) conds.push(sql`at < ${new Date(untilMs)}`);
      const rows = await db.execute<{ at: Date; actor: string; action: string; before: { display?: string } | null; after: { display?: string } | null; reason: string | null; batch_id: string | null; undone_by: string | null }>(
        sql`select at, actor, action, before, after, reason, batch_id, undone_by from audit_events_with_undo where ${sql.join(conds, sql` and `)} order by seq desc limit 400`,
      );
      const batches = new Map<string, { batchId: string; at: string; actor: string; reason: string | null; changes: string[]; count: number; undone: boolean }>();
      for (const r of rows) {
        if (r.action === "undo") continue;
        const key = r.batch_id ?? "";
        let b = batches.get(key);
        if (!b) batches.set(key, (b = { batchId: key, at: new Date(r.at).toISOString(), actor: r.actor, reason: r.reason, changes: [], count: 0, undone: true }));
        b.count++;
        if (b.changes.length < 5) b.changes.push(`${r.action}: ${r.before?.display ?? ""} → ${r.after?.display ?? ""}`);
        b.undone &&= r.undone_by !== null;
      }
      const list = [...batches.values()].slice(0, asInt(input.limit, 10, 30));
      return { result: list, summary: `Read ${plural(list.length, "batch", "batches")} from the audit log` };
    },

    async stats(input) {
      need(can(ctx.role, "file", "view"), "view files");
      const filter = asFilter(input.filter);
      const conds = filterSql(filter);
      const metric = asText(input.metric) === "size" ? "size" : "count";
      const value = metric === "size" ? sql<number>`coalesce(sum(${files.size}), 0)::bigint` : sql<number>`count(*)::int`;
      const groupBy = asText(input.groupBy) as StatGroup;
      const [totals] = await db.select({ files: count(), bytes: sql<number>`coalesce(sum(${files.size}), 0)::bigint` }).from(files).where(inSpace(...conds));
      const base = { question: asText(input.question).slice(0, 200), metric, filter, totalFiles: totals?.files ?? 0, totalBytes: Number(totals?.bytes ?? 0) };
      if (!(STAT_GROUPS as readonly string[]).includes(groupBy)) return { result: base, summary: `Counted ${plural(base.totalFiles, "file")}` };
      let groups: { key: string; value: number }[];
      if (groupBy === "kind") {
        const rows = await db.select({ key: files.ext, value }).from(files).where(inSpace(...conds)).groupBy(files.ext);
        const m = new Map<string, number>();
        for (const r of rows) m.set(kindOf(r.key), (m.get(kindOf(r.key)) ?? 0) + Number(r.value));
        groups = [...m].map(([key, v]) => ({ key, value: v }));
      } else if (groupBy === "flag") {
        const rows = await db.execute<{ key: string; value: number }>(
          sql`select f as key, ${metric === "size" ? sql`coalesce(sum(size), 0)::bigint` : sql`count(*)::int`} as value from ${files}, unnest(${files.flags}) as f where ${inSpace(...conds)} group by f`,
        );
        groups = rows.map((r) => ({ key: r.key, value: Number(r.value) }));
      } else {
        const expr = STAT_EXPR[groupBy];
        const rows = await db.select({ key: sql<string>`${expr}`, value }).from(files).where(inSpace(...conds)).groupBy(expr);
        groups = rows.map((r) => ({ key: r.key, value: Number(r.value) }));
      }
      groups.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
      const limit = asInt(input.limit, 30, 100);
      return { result: { ...base, groupBy, groups: groups.slice(0, limit), moreGroups: Math.max(0, groups.length - limit) }, summary: `Grouped ${plural(base.totalFiles, "file")} by ${groupBy}` };
    },
  };

  return {
    async run(name, input) {
      const handler = handlers[name];
      if (!handler) throw new AgentToolError(`There is no tool called "${name}".`);
      return handler(input);
    },
  };
}

function conditionsFrom(v: unknown): Condition[] {
  return Array.isArray(v) ? v.map((c: Record<string, unknown>) => ({ field: asText(c.field), op: asText(c.op), value: asText(c.value) }) as Condition) : [];
}
function actionsFrom(v: unknown): RuleAction[] {
  return Array.isArray(v) ? v.map((a: Record<string, unknown>) => ({ type: asText(a.type), value: asText(a.value) }) as RuleAction) : [];
}

/** Agent rule proposals are always Suggest: only an admin decides what runs automatically. */
export function ruleFromInput(input: Record<string, unknown>, priority: number): NewRule {
  return {
    type: "structured",
    name: asText(input.name).slice(0, 80) || "New rule",
    enabled: true,
    priority,
    match: input.match === "any" ? "any" : "all",
    conditions: conditionsFrom(input.conditions),
    actions: actionsFrom(input.actions),
    createdBy: "agent",
    createdAt: Date.now(),
    mode: "suggest",
    schedule: "none",
  };
}

export function ruleChanges(raw: Record<string, unknown>, old: Pick<Rule, "priority">): Partial<Rule> {
  const out: Partial<Rule> = {};
  if (raw.name !== undefined) out.name = asText(raw.name).slice(0, 80);
  if (raw.enabled !== undefined) out.enabled = Boolean(raw.enabled);
  if (raw.priority !== undefined) out.priority = asInt(raw.priority, old.priority);
  if (raw.match !== undefined) out.match = raw.match === "any" ? "any" : "all";
  if (raw.conditions !== undefined) out.conditions = conditionsFrom(raw.conditions);
  if (raw.actions !== undefined) out.actions = actionsFrom(raw.actions);
  return out;
}
