/**
 * The agent's tools. There is deliberately NO delete tool: the agent can only flag files
 * as "suggested for deletion". Every change it wants (move, rename, tag, caption, category,
 * rule create/update, undo) becomes a pending plan that the user must approve.
 */
import { db, type FileRecord, type PlanStep } from "../db";
import { createPlan, describeSteps, executePlan } from "../actions/engine";
import { sanitizeSuggestedName } from "../ai/parse";
import { matchesRule } from "../rules/evaluate";
import type { Condition, NewRule, Rule, RuleAction } from "../rules/types";
import { keywordSearch } from "../search";
import { getSettings } from "../settings";
import type { ToolDef } from "../ai/types";

export interface ToolContext {
  rootId: number;
  /** Plans the agent proposed during this turn, rendered as Plan Cards. */
  planIds: number[];
  /** Files the agent surfaced, rendered as chips. */
  fileIds: number[];
}

const str = { type: "string" } as const;
const int = { type: "integer" } as const;

const CONDITION_SCHEMA = {
  type: "object",
  properties: {
    field: { type: "string", enum: ["ext", "kind", "name", "content", "date", "size", "folder", "category", "flag", "tag"] },
    op: { type: "string", enum: ["is", "is_not", "contains", "not_contains", "starts_with", "before", "after", "within_days", "gt", "lt", "has"] },
    value: str,
  },
  required: ["field", "op", "value"],
};
const ACTION_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["move", "rename", "tag", "caption", "set_category", "flag_review"] },
    value: { type: "string", description: "Folder template, rename pattern, tag, caption or category. Variables: {year} {month} {date} {category} {client} {type} {name} {ext}." },
  },
  required: ["type", "value"],
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "get_overview",
    description: "Counts of files by category, type, flag and status in the current folder. Use first for broad questions.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    description: "List files in the current folder matching a filter. Returns up to `limit` (default 50) plus the total count.",
    parameters: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder path prefix, e.g. 'Clients/Alpha Ltd'" },
        category: str,
        kind: { type: "string", enum: ["image", "document", "spreadsheet", "video", "audio", "archive", "code", "other"] },
        ext: str,
        flag: { type: "string", enum: ["duplicate", "near_duplicate", "blurry", "dark", "tiny", "screenshot", "suggested_delete"] },
        status: { type: "string", enum: ["indexed", "analyzed", "needs_review", "organized", "trashed"] },
        limit: int,
      },
    },
  },
  {
    name: "search_files",
    description: "Keyword search over name, path, caption, tags, category, client and extracted text. Handles years and words like 'photos', 'pdf', 'screenshots'.",
    parameters: { type: "object", properties: { query: str, limit: int }, required: ["query"] },
  },
  {
    name: "get_file",
    description: "Full details for one file: metadata, AI category/caption/tags, flags, text excerpt.",
    parameters: { type: "object", properties: { id: int }, required: ["id"] },
  },
  {
    name: "propose_plan",
    description:
      "Propose changes for the user to approve (nothing changes until they click Approve). For 'move', `to` is the destination FOLDER (relative to the root). For 'rename', `to` is the new file name. For tag/untag/caption/category, `to` is the value.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short title, e.g. 'Organize invoices by client'" },
        reason: str,
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: { fileId: int, action: { type: "string", enum: ["move", "rename", "tag", "untag", "caption", "category"] }, to: str },
            required: ["fileId", "action", "to"],
          },
        },
      },
      required: ["summary", "steps"],
    },
  },
  {
    name: "create_rule",
    description: "Propose a new structured rule (IF conditions THEN actions). It is created only if the user approves.",
    parameters: {
      type: "object",
      properties: { name: str, match: { type: "string", enum: ["all", "any"] }, conditions: { type: "array", items: CONDITION_SCHEMA }, actions: { type: "array", items: ACTION_SCHEMA } },
      required: ["name", "conditions", "actions"],
    },
  },
  {
    name: "update_rule",
    description: "Propose changes to an existing rule (name, enabled, priority, match, conditions, actions). Applied only if the user approves.",
    parameters: {
      type: "object",
      properties: {
        id: int,
        changes: {
          type: "object",
          properties: { name: str, enabled: { type: "boolean" }, priority: int, match: { type: "string", enum: ["all", "any"] }, conditions: { type: "array", items: CONDITION_SCHEMA }, actions: { type: "array", items: ACTION_SCHEMA } },
        },
      },
      required: ["id", "changes"],
    },
  },
  {
    name: "flag_for_deletion",
    description: "Flag files as 'suggested for deletion'. This does NOT delete or trash anything; a human decides in Needs Review.",
    parameters: { type: "object", properties: { fileIds: { type: "array", items: int }, reason: str }, required: ["fileIds", "reason"] },
  },
  {
    name: "explain",
    description: "Explain why a file has its category and flags (AI reason, confidence, matching rules, analysis scores).",
    parameters: { type: "object", properties: { fileId: int }, required: ["fileId"] },
  },
  {
    name: "undo",
    description: "Propose undoing a previous batch of changes (batch ids are in the audit log; use list_recent_actions). Runs only if the user approves.",
    parameters: { type: "object", properties: { batchId: str }, required: ["batchId"] },
  },
  {
    name: "list_recent_actions",
    description: "Recent changes from the audit log, grouped by batch, newest first.",
    parameters: { type: "object", properties: { limit: int } },
  },
];

const compact = (f: FileRecord) => ({
  id: f.id,
  name: f.name,
  path: f.path,
  category: f.category,
  client: f.client,
  size: f.size,
  modified: new Date(f.mtime).toISOString().slice(0, 10),
  flags: f.flags.length ? f.flags : undefined,
  status: f.status,
});

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : fallback);
const text = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

async function rootFiles(ctx: ToolContext) {
  return db.files.where("rootId").equals(ctx.rootId).toArray();
}

async function fileInScope(ctx: ToolContext, id: unknown): Promise<FileRecord> {
  const f = await db.files.get(num(id, -1));
  if (!f || f.rootId !== ctx.rootId) throw new Error(`File ${String(id)} is not in the current folder`);
  return f;
}

function parseConditions(v: unknown): Condition[] {
  return Array.isArray(v) ? v.map((c: Record<string, unknown>) => ({ field: text(c.field), op: text(c.op), value: text(c.value) }) as Condition) : [];
}
function parseActions(v: unknown): RuleAction[] {
  return Array.isArray(v) ? v.map((a: Record<string, unknown>) => ({ type: text(a.type), value: text(a.value) }) as RuleAction) : [];
}

const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const cleanFolder = (p: string) =>
  p
    .split(/[\\/]+/)
    .map((s) => s.trim().replace(/[<>:"|?*\u0000-\u001f]/g, ""))
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");

type Handler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  async get_overview(_input, ctx) {
    const files = (await rootFiles(ctx)).filter((f) => f.status !== "trashed");
    const count = (key: (f: FileRecord) => string[] | string | undefined) => {
      const m: Record<string, number> = {};
      for (const f of files) for (const k of [key(f) ?? "—"].flat()) m[k] = (m[k] ?? 0) + 1;
      return m;
    };
    const root = await db.roots.get(ctx.rootId);
    return { folder: root?.name, total: files.length, byCategory: count((f) => f.category ?? "uncategorized"), byKind: count((f) => f.kind), byFlag: count((f) => f.flags), byStatus: count((f) => f.status) };
  },

  async list_files(input, ctx) {
    const folder = text(input.folder).replace(/^\/+|\/+$/g, "").toLowerCase();
    const matches = (await rootFiles(ctx)).filter(
      (f) =>
        (input.status ? f.status === input.status : f.status !== "trashed") &&
        (!folder || f.path.toLowerCase().startsWith(`${folder}/`)) &&
        (!input.category || (f.category ?? "").toLowerCase() === text(input.category).toLowerCase()) &&
        (!input.kind || f.kind === input.kind) &&
        (!input.ext || f.ext === text(input.ext).replace(/^\./, "").toLowerCase()) &&
        (!input.flag || f.flags.includes(input.flag as never)),
    );
    const limit = Math.min(200, num(input.limit, 50));
    const shown = matches.slice(0, limit);
    ctx.fileIds.push(...shown.slice(0, 30).map((f) => f.id));
    return { total: matches.length, files: shown.map(compact) };
  },

  async search_files(input, ctx) {
    const results = keywordSearch(await rootFiles(ctx), text(input.query)).slice(0, Math.min(100, num(input.limit, 20)));
    ctx.fileIds.push(...results.slice(0, 30).map((r) => r.file.id));
    return { total: results.length, files: results.map((r) => ({ ...compact(r.file), caption: r.file.caption })) };
  },

  async get_file(input, ctx) {
    const f = await fileInScope(ctx, input.id);
    ctx.fileIds.push(f.id);
    return { ...compact(f), tags: f.tags, caption: f.caption, suggestedName: f.suggestedName, confidence: f.confidence, width: f.width, height: f.height, exif: f.exif, textExcerpt: f.textExcerpt?.slice(0, 800) };
  },

  async propose_plan(input, ctx) {
    if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error("A plan needs at least one step");
    const steps: PlanStep[] = [];
    for (const raw of input.steps as Record<string, unknown>[]) {
      const f = await fileInScope(ctx, raw.fileId);
      if (f.status === "trashed") throw new Error(`${f.name} is in the Trash`);
      const action = text(raw.action);
      const to = text(raw.to);
      if (action === "move") {
        const dest = `${cleanFolder(to) ? `${cleanFolder(to)}/` : ""}${f.name}`;
        if (dest !== f.path) steps.push({ fileId: f.id, action: "move", from: f.path, to: dest, before: f.path, after: dest });
      } else if (action === "rename") {
        const name = sanitizeSuggestedName(to, f.name);
        const dest = `${folderOf(f.path) ? `${folderOf(f.path)}/` : ""}${name}`;
        if (dest !== f.path) steps.push({ fileId: f.id, action: "rename", from: f.path, to: dest, before: f.name, after: name });
      } else if (action === "tag" || action === "untag") {
        steps.push({ fileId: f.id, action, to: to.toLowerCase(), before: f.tags.join(", ") || "—", after: action === "tag" ? [...f.tags, to.toLowerCase()].join(", ") : f.tags.filter((t) => t !== to.toLowerCase()).join(", ") || "—" });
      } else if (action === "caption") {
        steps.push({ fileId: f.id, action: "caption", from: f.caption ?? "", to, before: f.caption || "—", after: to });
      } else if (action === "category") {
        steps.push({ fileId: f.id, action: "category", to, before: f.category || "—", after: to });
      } else {
        throw new Error(`Unsupported action "${action}". There is no delete; use flag_for_deletion.`);
      }
    }
    if (steps.length === 0) return { status: "nothing_to_do", note: "Every file is already where/how the plan wants it." };
    const planId = await createPlan({ rootId: ctx.rootId, source: "agent", actor: "agent", summary: text(input.summary) || describeSteps(steps), reason: text(input.reason) || undefined, steps });
    ctx.planIds.push(planId);
    return { planId, status: "pending_approval", changes: describeSteps(steps), note: "Shown to the user as a Plan Card. Nothing changes until they approve." };
  },

  async create_rule(input, ctx) {
    const existing = await db.rules.toArray();
    const rule: NewRule = {
      type: "structured",
      name: text(input.name) || "New rule",
      enabled: true,
      priority: existing.length + 1,
      match: input.match === "any" ? "any" : "all",
      conditions: parseConditions(input.conditions),
      actions: parseActions(input.actions),
      createdBy: "agent",
      createdAt: Date.now(),
    };
    if (!rule.conditions.length || !rule.actions.length) throw new Error("A rule needs at least one condition and one action");
    const files = await rootFiles(ctx);
    const matching = files.filter((f) => f.status !== "trashed" && matchesRule(f, { ...rule, id: -1 })).length;
    const planId = await createPlan({ rootId: ctx.rootId, source: "agent", actor: "agent", summary: `Create rule “${rule.name}”`, reason: `Would match ${matching} files right now`, steps: [{ action: "rule_create", to: JSON.stringify(rule), before: "—", after: rule.name }] });
    ctx.planIds.push(planId);
    return { planId, status: "pending_approval", wouldMatchNow: matching };
  },

  async update_rule(input, ctx) {
    const rule = await db.rules.get(num(input.id, -1));
    if (!rule) throw new Error(`Rule ${String(input.id)} not found`);
    const raw = (input.changes ?? {}) as Record<string, unknown>;
    const changes: Partial<Rule> = {};
    if (raw.name !== undefined) changes.name = text(raw.name);
    if (raw.enabled !== undefined) changes.enabled = Boolean(raw.enabled);
    if (raw.priority !== undefined) changes.priority = num(raw.priority, rule.priority);
    if (raw.match !== undefined) changes.match = raw.match === "any" ? "any" : "all";
    if (raw.conditions !== undefined) changes.conditions = parseConditions(raw.conditions);
    if (raw.actions !== undefined) changes.actions = parseActions(raw.actions);
    const planId = await createPlan({ rootId: ctx.rootId, source: "agent", actor: "agent", summary: `Update rule “${rule.name}”`, steps: [{ action: "rule_update", to: JSON.stringify({ id: rule.id, changes }), before: rule.name, after: Object.keys(changes).join(", ") || "no changes" }] });
    ctx.planIds.push(planId);
    return { planId, status: "pending_approval" };
  },

  async flag_for_deletion(input, ctx) {
    const ids = Array.isArray(input.fileIds) ? input.fileIds : [];
    const reason = text(input.reason) || "Suggested by the agent";
    const steps: PlanStep[] = [];
    for (const id of ids) {
      const f = await fileInScope(ctx, id);
      if (!f.flags.includes("suggested_delete") && f.status !== "trashed") steps.push({ fileId: f.id, action: "flag", to: "suggested_delete", before: "—", after: reason });
    }
    if (!steps.length) return { flagged: 0 };
    // Flagging is metadata only (no file changes), so it applies directly — logged and undoable.
    const planId = await createPlan({ rootId: ctx.rootId, source: "agent", actor: "agent", summary: `Flag ${steps.length} for deletion review`, reason, steps });
    await executePlan(planId);
    ctx.fileIds.push(...steps.map((s) => s.fileId!));
    return { flagged: steps.length, note: "Flagged only. The user decides in Needs Review; nothing was deleted or trashed." };
  },

  async explain(input, ctx) {
    const f = await fileInScope(ctx, input.fileId);
    const { thresholds } = await getSettings();
    const rules = (await db.rules.toArray()).filter((r) => r.enabled && matchesRule(f, r)).map((r) => r.name);
    ctx.fileIds.push(f.id);
    return {
      name: f.name,
      category: f.category ?? "not analyzed yet",
      categorySetBy: f.categorySource ?? null,
      aiReason: f.aiReason ?? null,
      confidence: f.confidence ?? null,
      needsReview: f.status === "needs_review" ? `confidence below ${thresholds.confidence}` : false,
      matchingRules: rules,
      flags: f.flags,
      analysis: {
        blurScore: f.blurScore !== undefined ? `${f.blurScore} (blurry below ${thresholds.blur})` : undefined,
        brightness: f.brightness !== undefined ? `${f.brightness} (dark below ${thresholds.dark})` : undefined,
        size: f.width ? `${f.width}×${f.height} (tiny below ${thresholds.tiny}px)` : undefined,
        sha256: f.sha256?.slice(0, 12),
      },
      flagReason: f.flagReason ?? null,
    };
  },

  async undo(input, ctx) {
    const batchId = text(input.batchId);
    const entries = (await db.audit.where("batchId").equals(batchId).toArray()).filter((e) => !e.undone && e.action !== "undo" && e.rootId === ctx.rootId);
    if (!entries.length) throw new Error(`Nothing to undo in batch ${batchId}`);
    const steps: PlanStep[] = entries.map((e) => ({ fileId: e.fileIds[0], action: e.action === "undo" ? "move" : e.action, before: e.after, after: e.before }));
    const planId = await createPlan({ rootId: ctx.rootId, source: "agent", actor: "agent", summary: `Undo: ${describeSteps(steps)}`, steps, undoBatchId: batchId });
    ctx.planIds.push(planId);
    return { planId, status: "pending_approval" };
  },

  async list_recent_actions(input, ctx) {
    const entries = await db.audit.where("rootId").equals(ctx.rootId).reverse().limit(400).toArray();
    const batches = new Map<string, { batchId: string; at: string; actor: string; reason?: string; changes: string[]; undone: boolean }>();
    for (const e of entries) {
      let b = batches.get(e.batchId);
      if (!b) {
        b = { batchId: e.batchId, at: new Date(e.at).toISOString(), actor: e.actor, reason: e.reason, changes: [], undone: true };
        batches.set(e.batchId, b);
      }
      if (b.changes.length < 5) b.changes.push(`${e.action}: ${e.before ?? ""} → ${e.after ?? ""}`);
      b.undone &&= e.undone;
    }
    return [...batches.values()].slice(0, Math.min(20, num(input.limit, 10)));
  },
};

export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
  const handler = HANDLERS[name];
  if (!handler) return { content: JSON.stringify({ error: `Unknown tool ${name}. There is no delete tool.` }), isError: true };
  try {
    return { content: JSON.stringify(await handler(input, ctx)), isError: false };
  } catch (err) {
    return { content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), isError: true };
  }
}
