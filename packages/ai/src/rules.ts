/** Natural-language rule → structured rule proposal (shown to a person, never saved automatically). */
import { z } from "zod";
import { OPS_BY_FIELD, regexProblem, ruleProblem, type ConditionField, type ConditionOp } from "@folderpilot/core";
import { extractJson } from "./parse";
import { collectChat, type AIProvider } from "./types";

const FIELDS = Object.keys(OPS_BY_FIELD) as [ConditionField, ...ConditionField[]];
const OPS = [...new Set(Object.values(OPS_BY_FIELD).flat())] as [ConditionOp, ...ConditionOp[]];
const ACTIONS = ["move", "rename", "tag", "caption", "set_category", "flag_review"] as const;

export const RuleProposalSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    match: z.enum(["all", "any"]).default("all"),
    conditions: z.array(z.object({ field: z.enum(FIELDS), op: z.enum(OPS), value: z.string().max(200) }).strip()).min(1).max(10),
    actions: z.array(z.object({ type: z.enum(ACTIONS), value: z.string().max(200).default("") }).strip()).min(1).max(10),
  })
  .strip()
  .superRefine((r, ctx) => {
    r.conditions.forEach((c, i) => {
      if (!OPS_BY_FIELD[c.field].includes(c.op)) ctx.addIssue({ code: "custom", path: ["conditions", i, "op"], message: `"${c.op}" doesn't work with ${c.field}` });
      if (c.op === "matches" && regexProblem(c.value)) ctx.addIssue({ code: "custom", path: ["conditions", i, "value"], message: regexProblem(c.value)! });
    });
    const problem = ruleProblem({ type: "structured", ...r });
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
export type RuleProposal = z.infer<typeof RuleProposalSchema>;

export function ruleProposalPrompt(knownCategories: string[]): string {
  const fields = Object.entries(OPS_BY_FIELD)
    .map(([f, ops]) => `${f}: ${ops.join(" | ")}`)
    .join("\n");
  return [
    "You convert a file-organizing rule written in plain English into ONE structured rule. Reply with ONLY a JSON object:",
    '{"name": string, "match": "all" | "any", "conditions": [{"field", "op", "value"}], "actions": [{"type", "value"}]}',
    "Condition fields and their ops:",
    fields,
    "Values: ext is a comma list without dots (pdf, jpg); kind is image|document|spreadsheet|video|audio|archive|code|other; date is YYYY-MM-DD or a number of days for within_days; size is in MB; flag is duplicate|near_duplicate|blurry|dark|tiny|screenshot|suggested_delete; matches takes a regular expression.",
    `Actions: move (folder template; variables {year} {month} {category} {client} {docType} {type}), rename (name pattern with the same variables plus {name} {date}), tag, caption, set_category, flag_review (value "").`,
    knownCategories.length ? `Existing categories: ${knownCategories.join(", ")}.` : "",
    "Never delete or trash anything — there is no such action. If the rule can't be expressed with these fields and actions, reply {\"error\": \"why\"}.",
  ]
    .filter(Boolean)
    .join("\n");
}

export class RuleProposalError extends Error {}

/** Ask the AI for a structured version of a natural-language rule, validated with zod. */
export async function proposeStructuredRule(provider: AIProvider, text: string, knownCategories: string[] = []): Promise<RuleProposal> {
  const res = await collectChat(provider.chat(ruleProposalPrompt(knownCategories), [{ role: "user", content: text }], []));
  let raw: unknown;
  try {
    raw = extractJson(res.content);
  } catch {
    throw new RuleProposalError("The AI didn't return a rule.");
  }
  if (raw && typeof raw === "object" && "error" in raw && typeof (raw as { error: unknown }).error === "string") throw new RuleProposalError((raw as { error: string }).error);
  const parsed = RuleProposalSchema.safeParse(raw);
  if (!parsed.success) throw new RuleProposalError(`The AI's rule wasn't valid: ${parsed.error.issues[0]?.message ?? "unknown problem"}.`);
  return parsed.data;
}
