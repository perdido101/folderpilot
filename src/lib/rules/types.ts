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
  id: number;
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

export const FIELD_LABELS: Record<ConditionField, string> = {
  ext: "File extension",
  kind: "File type",
  name: "Name",
  content: "Content",
  date: "Modified date",
  size: "Size (MB)",
  folder: "Folder",
  category: "AI category",
  flag: "Flag",
  tag: "Tag",
};

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

export const OP_LABELS: Record<ConditionOp, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  starts_with: "starts with",
  before: "is before",
  after: "is after",
  within_days: "within last N days",
  gt: "is larger than",
  lt: "is smaller than",
  has: "has",
};

export const ACTION_LABELS: Record<ActionType, string> = {
  move: "Move to folder",
  rename: "Rename by pattern",
  tag: "Add tag",
  caption: "Set caption",
  set_category: "Set category",
  flag_review: "Flag for review",
};
