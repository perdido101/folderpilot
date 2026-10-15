export type ConditionField = "ext" | "kind" | "name" | "content" | "date" | "size" | "folder" | "category" | "flag" | "tag" | "client" | "docType" | "space";
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
  | "has"
  /** Regular expression (case-insensitive). Invalid or unsafe patterns never match. */
  | "matches";

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

/** suggest: matches become a plan for a person to approve. auto: runs by itself (still audited and undoable). */
export type RuleMode = "suggest" | "auto";
export type RuleSchedule = "none" | "hourly" | "daily" | "weekly";

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
  /** Default "suggest". */
  mode?: RuleMode;
  /** Only this space (server space id or browser root id); undefined = every space. */
  scopeSpaceId?: string | number;
  /** Also run over the whole scope on a schedule (default "none"). */
  schedule?: RuleSchedule;
  lastRunAt?: number;
  /** Deleted rules are archived (audited, undoable) instead of removed. */
  archived?: boolean;
}

export type NewRule = Omit<Rule, "id">;


export const OPS_BY_FIELD: Record<ConditionField, ConditionOp[]> = {
  ext: ["is", "is_not"],
  kind: ["is", "is_not"],
  name: ["contains", "not_contains", "starts_with", "is", "matches"],
  content: ["contains", "not_contains", "matches"],
  date: ["before", "after", "within_days"],
  size: ["gt", "lt"],
  folder: ["is", "contains", "starts_with"],
  category: ["is", "is_not"],
  flag: ["has"],
  tag: ["has"],
  client: ["is", "is_not", "contains"],
  docType: ["is", "is_not", "contains"],
  space: ["is", "is_not"],
};
