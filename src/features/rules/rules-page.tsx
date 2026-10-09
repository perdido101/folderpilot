import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowDown, ArrowUp, MessageSquareText, Pencil, Play, Plus, Sparkles, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { proposeRules } from "@/lib/actions/organize";
import { runAgentTurn } from "@/lib/agent/agent";
import { ACTION_LABELS, FIELD_LABELS, OP_LABELS, type NewRule, type Rule } from "@/lib/rules/types";
import { deleteRule, logRuleChange } from "@/lib/rules/store";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { PlanDialog } from "@/features/plans/plan-card";
import { useActiveRoot } from "@/hooks/use-active-root";
import { toast } from "@/stores/toasts";
import { RuleBuilderDialog } from "./rule-builder";

const EMPTY: NewRule = { type: "structured", name: "", enabled: true, priority: 1, match: "all", conditions: [{ field: "flag", op: "has", value: "screenshot" }], actions: [{ type: "move", value: "Temp" }], createdBy: "user", createdAt: 0 };

function describe(rule: Rule) {
  const conds = rule.conditions.map((c) => `${FIELD_LABELS[c.field].toLowerCase()} ${OP_LABELS[c.op]} “${c.value}”`).join(rule.match === "all" ? " and " : " or ");
  const acts = rule.actions.map((a) => `${ACTION_LABELS[a.type].toLowerCase()}${a.value ? ` “${a.value}”` : ""}`).join(", ");
  return `If ${conds || "…"} → ${acts || "…"}`;
}

export function RulesPage() {
  const root = useActiveRoot();
  const rules = useLiveQuery(() => db.rules.orderBy("priority").toArray(), []) ?? [];
  const settings = useSettings();
  const [editing, setEditing] = useState<NewRule | Rule | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const [natural, setNatural] = useState("");
  const [converting, setConverting] = useState<number | null>(null);
  const structured = rules.filter((r) => r.type === "structured");
  const naturalRules = rules.filter((r) => r.type === "natural");
  const rootId = root?.id ?? 0;

  const propose = async (ruleId?: number) => {
    if (!root) return toast("Open a folder first.");
    const id = await proposeRules(root.id, ruleId);
    if (id === null) toast("No files match — nothing to change.");
    else setPlanId(id);
  };
  const move = async (rule: Rule, dir: -1 | 1) => {
    const list = [...structured];
    const i = list.findIndex((r) => r.id === rule.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    await db.transaction("rw", db.rules, async () => {
      for (const [k, r] of list.entries()) await db.rules.update(r.id, { priority: k + 1 });
    });
  };
  const convert = async (rule: Rule) => {
    if (!root) return;
    if (settings.ai.provider === "none") return toast("Connect an AI in Settings to convert rules.");
    setConverting(rule.id);
    try {
      const turn = await runAgentTurn(root.id, [], `Convert this natural-language rule into ONE structured rule with create_rule. Do not propose any other changes.\nRule: ${rule.naturalText}`);
      if (turn.planIds[0]) setPlanId(turn.planIds[0]);
      else toast(turn.reply || "The AI couldn't convert this rule.", "error");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setConverting(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-4xl space-y-8">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Workflow className="size-4 text-accent" />
            <h1 className="font-semibold">Rules</h1>
            <span className="text-xs text-muted">Structured rules run first (top to bottom), then natural-language rules via AI, then AI categorization.</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void propose()} disabled={!structured.some((r) => r.enabled)}>
                <Play />
                Run all…
              </Button>
              <Button size="sm" onClick={() => setEditing({ ...EMPTY, priority: structured.length + 1 })}>
                <Plus />
                New rule
              </Button>
            </div>
          </div>
          {structured.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted">No rules yet. Try “If flag has screenshot → move to Temp”.</p>}
          {structured.map((rule, i) => (
            <div key={rule.id} className={cn("flex items-center gap-3 rounded-lg border bg-surface p-3", !rule.enabled && "opacity-60")}>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => void logRuleChange({ ...rule, enabled: e.target.checked }, rootId)}
                className="size-4 accent-[rgb(var(--accent))]"
                aria-label={`Enable ${rule.name}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {rule.name} {rule.createdBy === "agent" && <span className="text-xs font-normal text-muted">· by agent</span>}
                </p>
                <p className="truncate text-xs text-muted" title={describe(rule)}>
                  {describe(rule)}
                </p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => void move(rule, -1)} disabled={i === 0} aria-label="Move up">
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void move(rule, 1)} disabled={i === structured.length - 1} aria-label="Move down">
                <ArrowDown />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(rule)} title="Edit and test (dry run)">
                <Pencil />
                Edit / Test
              </Button>
              <Button variant="outline" size="sm" onClick={() => void propose(rule.id)}>
                <Play />
                Run…
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void deleteRule(rule, rootId)} aria-label={`Delete rule ${rule.name}`}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <MessageSquareText className="size-4 text-accent" />
            <h2 className="font-semibold">Plain-language rules</h2>
            <span className="text-xs text-muted">Given to the AI when it categorizes files.</span>
          </div>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!natural.trim()) return;
              await logRuleChange({ type: "natural", name: natural.trim().slice(0, 60), enabled: true, priority: 1000, match: "all", conditions: [], actions: [], naturalText: natural.trim(), createdBy: "user", createdAt: Date.now() }, rootId);
              setNatural("");
            }}
          >
            <input
              value={natural}
              onChange={(e) => setNatural(e.target.value)}
              placeholder="e.g. Anything from Alpha Ltd is client work; bank PDFs are Statements"
              className="h-9 flex-1 rounded-lg border bg-surface px-3 text-sm"
              aria-label="New plain-language rule"
            />
            <Button type="submit" disabled={!natural.trim()}>
              Add
            </Button>
          </form>
          {naturalRules.map((rule) => (
            <div key={rule.id} className={cn("flex items-center gap-3 rounded-lg border bg-surface p-3", !rule.enabled && "opacity-60")}>
              <input type="checkbox" checked={rule.enabled} onChange={(e) => void logRuleChange({ ...rule, enabled: e.target.checked }, rootId)} className="size-4 accent-[rgb(var(--accent))]" aria-label="Enable rule" />
              <p className="min-w-0 flex-1 text-sm">{rule.naturalText}</p>
              <Button variant="outline" size="sm" onClick={() => void convert(rule)} disabled={converting === rule.id}>
                <Sparkles />
                {converting === rule.id ? "Converting…" : "Convert to structured"}
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void deleteRule(rule, rootId)} aria-label="Delete rule">
                <Trash2 />
              </Button>
            </div>
          ))}
        </section>
      </div>
      {editing && <RuleBuilderDialog initial={editing} onClose={() => setEditing(null)} />}
      <PlanDialog planId={planId} onClose={() => setPlanId(null)} />
    </div>
  );
}
