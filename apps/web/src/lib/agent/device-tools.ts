/**
 * The agent's tools for a folder on this device (Dexie + the browser engine). Same names and shapes as the server-space
 * tools (`@folderpilot/ai` AGENT_TOOLS). There is NO delete, trash or approve tool: every change is a plan a person
 * approves (unless they allowed small agent plans to run by themselves in Settings).
 */
import { asFilter, asInt, asText, PLAN_ACTIONS, sanitizeSuggestedName, STAT_GROUPS, type AgentToolRunner, type AIProvider, type FileFilter, type StatGroup, type ToolOutcome } from "@folderpilot/ai";
import { cleanFolderPath, dryRun, matchesRule, ruleProblem, type Condition, type NewRule, type Rule, type RuleAction } from "@folderpilot/core";
import { db, type FileRecord, type StepInput } from "../db";
import { createPlan, engine, executePlan, LOCAL_ACTOR } from "../actions/engine";
import { undoneIds } from "../actions/undone";
import { keywordSearch, semanticSearch } from "../search";
import { getSettings } from "../settings";

export class DeviceToolError extends Error {}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const toNum = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(asText(v));
  return Number.isFinite(n) ? n : -1;
};

const compact = (f: FileRecord) => ({
  id: f.id,
  name: f.name,
  path: f.path,
  category: f.category,
  client: f.client,
  docType: f.docType,
  size: f.size,
  modified: new Date(f.mtime).toISOString().slice(0, 10),
  flags: f.flags.length ? f.flags : undefined,
  tags: f.tags.length ? f.tags : undefined,
  status: f.status,
});

export function matchesFilter(f: FileRecord, filter: FileFilter): boolean {
  if (filter.status ? f.status !== filter.status : f.status === "trashed") return false;
  if (filter.folder && !f.path.toLowerCase().startsWith(`${filter.folder.toLowerCase()}/`)) return false;
  if (filter.category && (f.category ?? "").toLowerCase() !== filter.category.toLowerCase()) return false;
  if (filter.kind && f.kind !== filter.kind) return false;
  if (filter.ext && f.ext !== filter.ext) return false;
  if (filter.flag && !f.flags.includes(filter.flag as never)) return false;
  if (filter.client && !(f.client ?? "").toLowerCase().includes(filter.client.toLowerCase())) return false;
  if (filter.modifiedAfter && f.mtime < Date.parse(filter.modifiedAfter)) return false;
  if (filter.modifiedBefore && f.mtime >= Date.parse(filter.modifiedBefore)) return false;
  return true;
}

function statKeys(f: FileRecord, by: StatGroup): string[] {
  const d = new Date(f.mtime);
  switch (by) {
    case "category":
      return [f.category ?? "uncategorized"];
    case "kind":
      return [f.kind];
    case "ext":
      return [f.ext || "(none)"];
    case "flag":
      return f.flags;
    case "status":
      return [f.status];
    case "client":
      return [f.client ?? "(none)"];
    case "docType":
      return [f.docType ?? "(none)"];
    case "folder":
      return [f.path.includes("/") ? f.path.split("/")[0]! : "(top level)"];
    case "year":
      return [String(d.getFullYear())];
    case "month":
      return [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`];
  }
}

function conditionsFrom(v: unknown): Condition[] {
  return Array.isArray(v) ? v.map((c: Record<string, unknown>) => ({ field: asText(c.field), op: asText(c.op), value: asText(c.value) }) as Condition) : [];
}
function actionsFrom(v: unknown): RuleAction[] {
  return Array.isArray(v) ? v.map((a: Record<string, unknown>) => ({ type: asText(a.type), value: asText(a.value) }) as RuleAction) : [];
}
function ruleChanges(raw: Record<string, unknown>, old: Pick<Rule, "priority">): Partial<Rule> {
  const out: Partial<Rule> = {};
  if (raw.name !== undefined) out.name = asText(raw.name).slice(0, 80);
  if (raw.enabled !== undefined) out.enabled = Boolean(raw.enabled);
  if (raw.priority !== undefined) out.priority = asInt(raw.priority, old.priority);
  if (raw.match !== undefined) out.match = raw.match === "any" ? "any" : "all";
  if (raw.conditions !== undefined) out.conditions = conditionsFrom(raw.conditions);
  if (raw.actions !== undefined) out.actions = actionsFrom(raw.actions);
  return out;
}

export function createDeviceTools(rootId: number, opts: { provider?: AIProvider | null } = {}): AgentToolRunner {
  const rootFiles = () => db.files.where("rootId").equals(rootId).toArray();
  async function fileOr(id: unknown): Promise<FileRecord> {
    const f = await db.files.get(toNum(id));
    if (!f || f.rootId !== rootId) throw new DeviceToolError(`File ${asText(id) || "(none)"} is not in this folder.`);
    return f;
  }

  /** Create the plan; run it at once only when the person allowed small agent plans. */
  async function propose(summary: string, steps: StepInput[], reason?: string) {
    const planId = await createPlan({ rootId, source: "agent", actor: LOCAL_ACTOR.agent, summary, ...(reason ? { reason } : {}), steps });
    const { agentAutoRunMaxFiles } = await getSettings();
    if (await engine.autoApproveSmall(planId, { maxFiles: agentAutoRunMaxFiles, allowMcp: false })) {
      const r = await executePlan(planId);
      return { planId, status: "executed", ran: { done: r.done, failed: r.failed } };
    }
    return { planId, status: "pending_approval" };
  }
  const describePlan = (p: { status: string; ran?: { done: number } }) => (p.status === "pending_approval" ? "Plan waiting for approval" : `Ran automatically (${plural(p.ran?.done ?? 0, "change")})`);
  const ids = (list: FileRecord[]) => list.slice(0, 30).map((f) => String(f.id));

  const handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolOutcome>> = {
    async search_files(input) {
      const filter = asFilter(input.filters);
      const files = (await rootFiles()).filter((f) => matchesFilter(f, filter));
      const query = asText(input.query);
      const hasEmbeddings = opts.provider?.embed && (await db.embeddings.where("rootId").equals(rootId).count()) > 0;
      const results = hasEmbeddings ? await semanticSearch(rootId, files, query, opts.provider!) : keywordSearch(files, query);
      const shown = results.slice(0, asInt(input.limit, 20, 100)).map((r) => r.file);
      return { result: { total: results.length, files: shown.map((f) => ({ ...compact(f), caption: f.caption })) }, summary: `Found ${plural(results.length, "file")}`, fileIds: ids(shown) };
    },

    async list_files(input) {
      const matches = (await rootFiles()).filter((f) => matchesFilter(f, asFilter(input)));
      const offset = asInt(input.offset, 0);
      const shown = matches.slice(offset, offset + asInt(input.limit, 50, 200));
      return { result: { total: matches.length, files: shown.map(compact) }, summary: `Listed ${plural(shown.length, "file")} of ${matches.length}`, fileIds: ids(shown) };
    },

    async get_file(input) {
      const f = await fileOr(input.id);
      return {
        result: { ...compact(f), caption: f.caption, suggestedName: f.suggestedName, confidence: f.confidence, width: f.width, height: f.height, exif: f.exif, textExcerpt: f.textExcerpt?.slice(0, 800) },
        summary: f.name,
        fileIds: [String(f.id)],
      };
    },

    async explain_categorization(input) {
      const f = await fileOr(input.fileId);
      const { thresholds } = await getSettings();
      const rules = (await db.rules.toArray()).filter((r) => r.enabled && !r.archived && matchesRule(f, r)).map((r) => ({ name: r.name, mode: r.mode ?? "suggest" }));
      return {
        result: {
          name: f.name,
          category: f.category ?? "not analyzed yet",
          categorySetBy: f.categorySource ?? null,
          aiReason: f.aiReason ?? null,
          confidence: f.confidence ?? null,
          needsReview: f.status === "needs_review" ? `AI confidence below ${thresholds.confidence}` : false,
          matchingRules: rules,
          flags: f.flags,
          flagReason: f.flagReason ?? null,
          analysis: {
            blurScore: f.blurScore !== undefined ? `${f.blurScore} (blurry below ${thresholds.blur})` : undefined,
            brightness: f.brightness !== undefined ? `${f.brightness} (dark below ${thresholds.dark})` : undefined,
            size: f.width ? `${f.width}×${f.height} (tiny below ${thresholds.tiny}px)` : undefined,
          },
        },
        summary: `Explained ${f.name}`,
        fileIds: [String(f.id)],
      };
    },

    async propose_plan(input) {
      const raw = Array.isArray(input.steps) ? (input.steps as Record<string, unknown>[]) : [];
      if (!raw.length) throw new DeviceToolError("A plan needs at least one step.");
      if (raw.length > 500) throw new DeviceToolError("Plans are limited to 500 steps; split the work.");
      const steps: StepInput[] = [];
      for (const r of raw) {
        const f = await fileOr(r.fileId);
        if (f.status === "trashed") throw new DeviceToolError(`${f.name} is in the Trash.`);
        const action = asText(r.action);
        const to = asText(r.to).trim();
        if (!(PLAN_ACTIONS as readonly string[]).includes(action)) throw new DeviceToolError(`Unsupported action "${action}". There is no delete; use flag_for_deletion.`);
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
          const has = f.tags.includes(tag);
          if (!tag || (action === "tag" && has) || (action === "untag" && !has)) continue;
          steps.push({ fileId: f.id, action, to: tag, before: f.tags.join(", ") || "—", after: action === "tag" ? [...f.tags, tag].join(", ") : f.tags.filter((x) => x !== tag).join(", ") || "—" });
        } else if (action === "caption") {
          steps.push({ fileId: f.id, action: "caption", from: f.caption ?? "", to, before: f.caption || "—", after: to });
        } else if (to && to !== f.category) {
          steps.push({ fileId: f.id, action: "category", from: f.category ?? "", to, before: f.category || "—", after: to });
        }
      }
      if (!steps.length) return { result: { status: "nothing_to_do", note: "Every file is already the way the plan wants it." }, summary: "Nothing to change" };
      const p = await propose(asText(input.summary).slice(0, 200) || "Agent plan", steps, asText(input.reason).slice(0, 500) || undefined);
      return {
        result: { ...p, changes: steps.length, note: p.status === "pending_approval" ? "Shown to the person as a Plan Card. Nothing changes until it is approved." : "Ran automatically under the person's auto-run setting." },
        summary: describePlan(p),
        planIds: [String(p.planId)],
      };
    },

    async propose_rule(input) {
      const existing = await db.rules.toArray();
      const rule: NewRule = {
        type: "structured",
        name: asText(input.name).slice(0, 80) || "New rule",
        enabled: true,
        priority: existing.length + 1,
        match: input.match === "any" ? "any" : "all",
        conditions: conditionsFrom(input.conditions),
        actions: actionsFrom(input.actions),
        createdBy: "agent",
        createdAt: Date.now(),
        mode: "suggest",
        schedule: "none",
      };
      const problem = ruleProblem(rule);
      if (problem) throw new DeviceToolError(problem);
      const { matches } = dryRun(await rootFiles(), { ...rule, id: -1 });
      const planId = await createPlan({ rootId, source: "agent", actor: LOCAL_ACTOR.agent, summary: `Create rule “${rule.name}”`, reason: `Would match ${plural(matches.length, "file")} right now`, steps: [{ action: "rule_create", to: JSON.stringify(rule), before: "—", after: rule.name }] });
      return { result: { planId, status: "pending_approval", wouldMatchNow: matches.length, mode: "suggest" }, summary: `Rule proposal (matches ${matches.length} now)`, planIds: [String(planId)] };
    },

    async update_rule_proposal(input) {
      const changes = (input.changes ?? {}) as Record<string, unknown>;
      if (input.planId !== undefined && asText(input.planId)) {
        const plan = await db.plans.get(toNum(input.planId));
        const step = plan?.status === "pending" && plan.rootId === rootId ? plan.steps.find((s) => s.action === "rule_create") : undefined;
        if (!plan || !step) throw new DeviceToolError(`Plan ${asText(input.planId)} isn't a rule proposal waiting for approval.`);
        const old = JSON.parse(step.to ?? "{}") as NewRule;
        const next: NewRule = { ...old, ...ruleChanges(changes, old) };
        const problem = ruleProblem(next);
        if (problem) throw new DeviceToolError(problem);
        await engine.cancel(plan.id);
        const planId = await createPlan({ rootId, source: "agent", actor: LOCAL_ACTOR.agent, summary: `Create rule “${next.name}”`, reason: "Revised proposal", steps: [{ action: "rule_create", to: JSON.stringify(next), before: "—", after: next.name }] });
        return { result: { planId, replaces: plan.id, status: "pending_approval" }, summary: "Revised rule proposal", planIds: [String(planId)] };
      }
      const rule = await db.rules.get(toNum(input.ruleId));
      if (!rule || rule.archived) throw new DeviceToolError(`Rule ${asText(input.ruleId) || "(none)"} not found.`);
      if (changes.mode === "auto") throw new DeviceToolError("The agent can't make a rule run automatically; change the mode yourself on the Rules page.");
      const patch = ruleChanges(changes, rule);
      const problem = ruleProblem({ ...rule, ...patch });
      if (problem) throw new DeviceToolError(problem);
      const planId = await createPlan({ rootId, source: "agent", actor: LOCAL_ACTOR.agent, summary: `Update rule “${rule.name}”`, steps: [{ action: "rule_update", to: JSON.stringify({ id: rule.id, changes: patch }), before: rule.name, after: Object.keys(patch).join(", ") || "no changes" }] });
      return { result: { planId, status: "pending_approval" }, summary: "Rule change waiting for approval", planIds: [String(planId)] };
    },

    async flag_for_deletion(input) {
      const list = Array.isArray(input.fileIds) ? input.fileIds.slice(0, 500) : [];
      const reason = asText(input.reason).slice(0, 300) || "Suggested by the agent";
      const steps: StepInput[] = [];
      for (const id of list) {
        const f = await fileOr(id);
        if (!f.flags.includes("suggested_delete") && f.status !== "trashed") steps.push({ fileId: f.id, action: "flag", to: "suggested_delete", before: "—", after: `Suggested for deletion: ${reason}` });
      }
      if (!steps.length) return { result: { flagged: 0, note: "Those files are already flagged (or in the Trash)." }, summary: "Nothing to flag" };
      const p = await propose(`Suggest ${plural(steps.length, "file")} for deletion`, steps, reason);
      return {
        result: { ...p, files: steps.length, note: "This only flags files for review; nothing is deleted or trashed. A person decides in Needs Review." },
        summary: describePlan(p),
        planIds: [String(p.planId)],
        fileIds: steps.map((s) => String(s.fileId)),
      };
    },

    async propose_undo(input) {
      const batchId = asText(input.batchId);
      const since = Date.parse(asText(input.since));
      const target = batchId ? { batchId } : !Number.isNaN(since) ? { since, actorPrefix: "agent" } : null;
      if (!target) throw new DeviceToolError("Pass a batchId (from get_audit) or a 'since' time.");
      const planId = await engine.planUndo(target, { source: "agent", actor: LOCAL_ACTOR.agent, spaceId: rootId }).catch((err: unknown) => {
        throw new DeviceToolError(err instanceof Error ? err.message : String(err));
      });
      if (planId === null) throw new DeviceToolError("There's nothing left to undo there.");
      return { result: { planId: Number(planId), status: "pending_approval" }, summary: "Undo waiting for approval", planIds: [String(planId)] };
    },

    async get_audit(input) {
      const actor = asText(input.actor).trim();
      const action = asText(input.action).trim();
      const fileId = input.fileId !== undefined && asText(input.fileId) ? toNum(input.fileId) : null;
      const since = Date.parse(asText(input.since));
      const until = Date.parse(asText(input.until));
      const all = await db.audit.where("rootId").equals(rootId).reverse().limit(2000).toArray();
      const undone = undoneIds(all);
      const entries = all.filter(
        (e) =>
          e.action !== "undo" &&
          (!actor || e.actor.startsWith(actor)) &&
          (!action || e.action === action) &&
          (fileId === null || e.fileIds.includes(fileId)) &&
          (Number.isNaN(since) || e.at >= since) &&
          (Number.isNaN(until) || e.at < until),
      );
      const batches = new Map<string, { batchId: string; at: string; actor: string; reason?: string; changes: string[]; count: number; undone: boolean }>();
      for (const e of entries) {
        let b = batches.get(e.batchId);
        if (!b) batches.set(e.batchId, (b = { batchId: e.batchId, at: new Date(e.at).toISOString(), actor: e.actor, ...(e.reason ? { reason: e.reason } : {}), changes: [], count: 0, undone: true }));
        b.count++;
        if (b.changes.length < 5) b.changes.push(`${e.action}: ${e.before ?? ""} → ${e.after ?? ""}`);
        b.undone &&= undone.has(e.id);
      }
      const list = [...batches.values()].slice(0, asInt(input.limit, 10, 30));
      return { result: list, summary: `Read ${plural(list.length, "batch", "batches")} from the audit log` };
    },

    async stats(input) {
      const filter = asFilter(input.filter);
      const files = (await rootFiles()).filter((f) => matchesFilter(f, filter));
      const metric = asText(input.metric) === "size" ? "size" : "count";
      const base = { question: asText(input.question).slice(0, 200), metric, filter, totalFiles: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0) };
      const groupBy = asText(input.groupBy) as StatGroup;
      if (!(STAT_GROUPS as readonly string[]).includes(groupBy)) return { result: base, summary: `Counted ${plural(files.length, "file")}` };
      const m = new Map<string, number>();
      for (const f of files) for (const k of statKeys(f, groupBy)) m.set(k, (m.get(k) ?? 0) + (metric === "size" ? f.size : 1));
      const groups = [...m].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
      const limit = asInt(input.limit, 30, 100);
      return { result: { ...base, groupBy, groups: groups.slice(0, limit), moreGroups: Math.max(0, groups.length - limit) }, summary: `Grouped ${plural(files.length, "file")} by ${groupBy}` };
    },
  };

  return {
    async run(name, input) {
      const handler = handlers[name];
      if (!handler) throw new DeviceToolError(`There is no tool called "${name}".`);
      return handler(input);
    },
  };
}
