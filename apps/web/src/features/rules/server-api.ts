/** Rules and pending plans of an organization on a FolderPilot server: typed calls + React Query hooks. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Condition, NewRule, Rule, RuleAction, RuleMode, RuleSchedule } from "@folderpilot/core";
import { api } from "@/lib/api";

export interface ServerRule {
  id: string;
  type: "structured" | "natural";
  name: string;
  enabled: boolean;
  priority: number;
  match: "all" | "any";
  conditions: Condition[];
  actions: RuleAction[];
  naturalText: string | null;
  mode: RuleMode;
  scopeSpaceId: string | null;
  schedule: RuleSchedule;
  lastRunAt: number | null;
  archived: boolean;
  createdBy: string;
  createdAt: number;
}

export interface PreviewStep {
  fileId?: string | number;
  name: string;
  action: string;
  before: string;
  after: string;
}
export interface RulePreview {
  matches: number;
  changes: number;
  steps: PreviewStep[];
}

export interface ServerRuleOutcome {
  ruleId: string;
  ruleName: string;
  mode: RuleMode;
  planId: string;
  files: number;
  result?: { status: string; done: number; failed: number; conflicted: number; errors: string[] };
  error?: string;
}

export interface ServerPlan {
  id: string;
  source: "user" | "agent" | "rule" | "mcp";
  actor: string;
  summary: string;
  reason: string | null;
  status: string;
  createdAt: number;
  fileCount: number;
  steps: { seq: number; action: string; fileId: string | null; name: string; before: string; after: string; status: string }[];
}

export interface PlanRunResult {
  planId: string;
  batchId: string;
  status: string;
  done: number;
  failed: number;
  conflicted: number;
  errors: string[];
}

/** Server rule → the shape the rules engine and builder use. */
export function fromServer(r: ServerRule): Rule {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    enabled: r.enabled,
    priority: r.priority,
    match: r.match,
    conditions: r.conditions,
    actions: r.actions,
    ...(r.naturalText ? { naturalText: r.naturalText } : {}),
    createdBy: r.createdBy.startsWith("agent") ? "agent" : "user",
    createdAt: r.createdAt,
    mode: r.mode,
    ...(r.scopeSpaceId ? { scopeSpaceId: r.scopeSpaceId } : {}),
    schedule: r.schedule,
    ...(r.lastRunAt ? { lastRunAt: r.lastRunAt } : {}),
    archived: r.archived,
  };
}

/** The editable fields, as the API takes them (null clears the scope). */
export function toServerBody(rule: NewRule | Rule) {
  return {
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    match: rule.match,
    conditions: rule.type === "structured" ? rule.conditions : [],
    actions: rule.type === "structured" ? rule.actions : [],
    naturalText: rule.naturalText ?? null,
    mode: rule.mode ?? "suggest",
    scopeSpaceId: rule.scopeSpaceId === undefined ? null : String(rule.scopeSpaceId),
    schedule: rule.schedule ?? "none",
  };
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const rulesKey = (orgId: string) => ["org-rules", orgId];

export function useServerRules(orgId: string | undefined) {
  return useQuery({ queryKey: rulesKey(orgId ?? ""), enabled: Boolean(orgId), queryFn: () => api<{ rules: ServerRule[] }>(`/api/orgs/${orgId}/rules`) });
}

export function useServerRuleMutations(orgId: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: rulesKey(orgId) });
  return {
    create: (rule: NewRule) => api<{ rule: ServerRule; batchId: string }>(`/api/orgs/${orgId}/rules`, json({ type: rule.type, ...toServerBody(rule) })).finally(invalidate),
    update: (id: string, changes: Record<string, unknown>) => api<{ rule: ServerRule; batchId: string }>(`/api/orgs/${orgId}/rules/${id}`, { method: "PUT", body: JSON.stringify(changes) }).finally(invalidate),
    archive: (id: string) => api<{ rule: ServerRule; batchId: string }>(`/api/orgs/${orgId}/rules/${id}`, { method: "DELETE" }).finally(invalidate),
    undo: (batchId: string) => api<{ done: number; failed: number; errors: string[] }>(`/api/orgs/${orgId}/rules/undo`, json({ batchId })).finally(invalidate),
    preview: (rule: NewRule | Rule, spaceId?: string) =>
      api<RulePreview>(`/api/orgs/${orgId}/rules/test`, json({ rule: { type: rule.type, ...toServerBody(rule) }, ...(spaceId ? { spaceId } : {}), limit: 10 })),
    run: (spaceId: string, ruleId?: string, folder?: string) =>
      api<{ files: number; outcomes: ServerRuleOutcome[] }>(`/api/orgs/${orgId}/rules/run`, json({ spaceId, ...(ruleId ? { ruleId } : {}), ...(folder ? { folder } : {}) })).finally(() =>
        qc.invalidateQueries({ queryKey: ["space", spaceId] }),
      ),
    convert: (text: string) => api<{ proposal: Pick<NewRule, "name" | "match" | "conditions" | "actions"> }>(`/api/orgs/${orgId}/rules/convert`, json({ text })),
  };
}

export function useServerPlans(orgId: string, spaceId: string) {
  return useQuery({
    queryKey: ["space", spaceId, "plans", "pending"],
    queryFn: () => api<{ plans: ServerPlan[] }>(`/api/orgs/${orgId}/spaces/${spaceId}/plans?status=pending`),
    refetchInterval: 15_000,
  });
}

export function useServerPlan(orgId: string, spaceId: string, planId: string) {
  return useQuery({
    queryKey: ["space", spaceId, "plan", planId],
    queryFn: () => api<{ plan: ServerPlan }>(`/api/orgs/${orgId}/plans/${planId}`),
    // Auto-run plans finish within a moment of being proposed.
    refetchInterval: (q) => (q.state.data?.plan.status === "executing" || q.state.data?.plan.status === "approved" ? 1000 : false),
  });
}

export function useServerPlanActions(orgId: string, spaceId: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["space", spaceId] });
  return {
    approve: (planId: string) => api<PlanRunResult>(`/api/orgs/${orgId}/plans/${planId}/approve`, { method: "POST" }).finally(invalidate),
    keepSteps: (planId: string, seqs: number[]) => api<{ ok: boolean }>(`/api/orgs/${orgId}/plans/${planId}/keep-steps`, json({ seqs })).finally(invalidate),
    cancel: (planId: string) => api<{ ok: boolean }>(`/api/orgs/${orgId}/plans/${planId}/cancel`, { method: "POST" }).finally(invalidate),
  };
}
