export type ConditionField = "ext" | "kind" | "name" | "content" | "date" | "size" | "folder" | "category" | "flag" | "tag";
export type ConditionOp =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "before"
  | "after"
  | "within_days"
  | "gt"
  | "lt"
  | "has";

export interface Condition {
  field: ConditionField;
  op: ConditionOp;
  value: string;
}

export type ActionType = "move" | "rename" | "tag" | "caption" | "set_category" | "flag_review";

export interface RuleAction {
  type: ActionType;
  /** Folder template, rename pattern, tag, caption or category. Unused for flag_review. */
  value: string;
}

export interface Rule {
  id: number | string;
  type: "structured" | "natural";
  name: string;
  enabled: boolean;
  /** Lower runs first. */
  priority: number;
  match: "all" | "any";
  conditions: Condition[];
  actions: RuleAction[];
  /** For natural-language rules: injected verbatim into the AI prompt. */
  naturalText?: string;
  createdBy: "user" | "agent";
  createdAt: number;
}

export type NewRule = Omit<Rule, "id">;


export const OPS_BY_FIELD: Record<ConditionField, ConditionOp[]> = {
  ext: ["is", "is_not"],
  kind: ["is", "is_not"],
  name: ["contains", "not_contains", "starts_with", "is"],
  content: ["contains", "not_contains"],
  date: ["before", "after", "within_days"],
  size: ["gt", "lt"],
  folder: ["is", "contains", "starts_with"],
  category: ["is", "is_not"],
  flag: ["has"],
  tag: ["has"],
};
