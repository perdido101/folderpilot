/**
 * The agent's tools (spec §9), shared by every runtime: the browser ("This device"), server spaces and, later, the MCP
 * server. There is deliberately NO delete or trash tool and no approve tool: changes come back as plans a person approves.
 */
import { OPS_BY_FIELD } from "@folderpilot/core";
import type { ToolDef } from "../types";

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const id = { type: "string", description: "An id exactly as returned by another tool." } as const;

const KINDS = ["image", "document", "spreadsheet", "video", "audio", "archive", "code", "other"];
const FLAGS = ["duplicate", "near_duplicate", "blurry", "dark", "tiny", "screenshot", "suggested_delete"];
const STATUSES = ["indexed", "analyzed", "needs_review", "organized", "trashed"];
export const STAT_GROUPS = ["category", "kind", "ext", "flag", "status", "client", "docType", "folder", "year", "month"] as const;
export type StatGroup = (typeof STAT_GROUPS)[number];
export const PLAN_ACTIONS = ["move", "rename", "tag", "untag", "caption", "category"] as const;

const FILTER = {
  type: "object",
  description: "Optional filters (all must match).",
  properties: {
    folder: { type: "string", description: "Folder path prefix, e.g. 'Clients/Alpha Ltd'" },
    category: str,
    kind: { type: "string", enum: KINDS },
    ext: { type: "string", description: "Without the dot, e.g. 'pdf'" },
    flag: { type: "string", enum: FLAGS },
    status: { type: "string", enum: STATUSES },
    client: str,
    modifiedAfter: { type: "string", description: "YYYY-MM-DD" },
    modifiedBefore: { type: "string", description: "YYYY-MM-DD" },
  },
};

const CONDITION = {
  type: "object",
  properties: {
    field: { type: "string", enum: Object.keys(OPS_BY_FIELD) },
    op: { type: "string", enum: [...new Set(Object.values(OPS_BY_FIELD).flat())] },
    value: str,
  },
  required: ["field", "op", "value"],
};
const ACTION = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["move", "rename", "tag", "caption", "set_category", "flag_review"] },
    value: { type: "string", description: "Folder template, rename pattern, tag, caption or category. Variables: {year} {month} {date} {category} {client} {docType} {type} {name} {ext}." },
  },
  required: ["type", "value"],
};
const RULE_FIELDS = { name: str, match: { type: "string", enum: ["all", "any"] }, conditions: { type: "array", items: CONDITION }, actions: { type: "array", items: ACTION } };

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: "search_files",
    description: "Search files by meaning and keywords (name, path, caption, tags, category, client, extracted text). Understands years and words like 'photos', 'pdf', 'screenshots'.",
    parameters: { type: "object", properties: { query: str, filters: FILTER, limit: int }, required: ["query"] },
  },
  {
    name: "list_files",
    description: "List files matching filters, with the total count. Default limit 50, max 200.",
    parameters: { type: "object", properties: { ...FILTER.properties, limit: int, offset: int } },
  },
  {
    name: "get_file",
    description: "Full details for one file: metadata, AI category/caption/tags/entities, flags, text excerpt.",
    parameters: { type: "object", properties: { id }, required: ["id"] },
  },
  {
    name: "explain_categorization",
    description: "Explain why a file has its category, status and flags: who set it (AI, rule, person), the AI's reason and confidence, matching rules, analysis scores.",
    parameters: { type: "object", properties: { fileId: id }, required: ["fileId"] },
  },
  {
    name: "propose_plan",
    description:
      "Propose changes for a person to approve (nothing changes until they click Approve). For 'move', `to` is the destination FOLDER. For 'rename', `to` is the new file name. For tag/untag/caption/category, `to` is the value.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short title, e.g. 'File invoices by client'" },
        reason: str,
        steps: {
          type: "array",
          items: { type: "object", properties: { fileId: id, action: { type: "string", enum: PLAN_ACTIONS }, to: str }, required: ["fileId", "action", "to"] },
        },
      },
      required: ["summary", "steps"],
    },
  },
  {
    name: "propose_rule",
    description: "Propose a new structured rule (IF conditions THEN actions). It is created (in Suggest mode) only if a person approves. Reports how many files it would match now.",
    parameters: { type: "object", properties: RULE_FIELDS, required: ["name", "conditions", "actions"] },
  },
  {
    name: "update_rule_proposal",
    description:
      "Change a rule: pass `ruleId` to propose edits to an existing rule, or `planId` to revise a rule you proposed earlier that is still waiting for approval (the old proposal is withdrawn). Applied only if a person approves.",
    parameters: {
      type: "object",
      properties: { ruleId: id, planId: id, changes: { type: "object", properties: { ...RULE_FIELDS, enabled: { type: "boolean" }, priority: int } } },
      required: ["changes"],
    },
  },
  {
    name: "flag_for_deletion",
    description: "Suggest files for deletion. This does NOT delete or trash anything: it proposes a 'suggested for deletion' flag; a person decides in Needs Review.",
    parameters: { type: "object", properties: { fileIds: { type: "array", items: id }, reason: str }, required: ["fileIds", "reason"] },
  },
  {
    name: "propose_undo",
    description: "Propose undoing earlier changes: one batch (`batchId` from get_audit) or everything the agent did since a time (`since`, ISO date-time). Runs only if a person approves.",
    parameters: { type: "object", properties: { batchId: id, since: str } },
  },
  {
    name: "get_audit",
    description: "The audit log (who changed what, when, why), newest first, grouped by batch. Filter by actor prefix ('user', 'agent', 'rule'), action, file, or time range.",
    parameters: { type: "object", properties: { actor: str, action: str, fileId: id, since: str, until: str, limit: int } },
  },
  {
    name: "stats",
    description: "Counts or total size over the index, grouped by a field (e.g. 'how many invoices per client this year?'). Restate the user's question in `question`.",
    parameters: {
      type: "object",
      properties: { question: str, groupBy: { type: "string", enum: STAT_GROUPS }, metric: { type: "string", enum: ["count", "size"] }, filter: FILTER, limit: int },
      required: ["question"],
    },
  },
];

export const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));

/** Typed view of the filter object every runtime understands. */
export interface FileFilter {
  folder?: string;
  category?: string;
  kind?: string;
  ext?: string;
  flag?: string;
  status?: string;
  client?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
}

/** Lenient parsing of model-supplied values (models send numbers as strings and vice versa). */
export const asText = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
export const asInt = (v: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.trunc(n))) : fallback;
};
export function asFilter(v: unknown): FileFilter {
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  const out: FileFilter = {};
  for (const k of ["folder", "category", "kind", "ext", "flag", "status", "client", "modifiedAfter", "modifiedBefore"] as const) {
    const s = asText(o[k]).trim();
    if (s) out[k] = k === "ext" ? s.replace(/^\./, "").toLowerCase() : k === "folder" ? s.replace(/^\/+|\/+$/g, "") : s;
  }
  return out;
}
