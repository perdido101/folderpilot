import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Archive, ArrowDown, ArrowUp, CalendarClock, MessageSquareText, Pencil, Play, Plus, Sparkles, Workflow, Zap } from "lucide-react";
import { Button, cn } from "@folderpilot/ui";
import type { NewRule, Rule } from "@folderpilot/core";
import { PlanDialog } from "@/features/plans/plan-card";
import { formatDate } from "@/lib/format";
import { navigateTo } from "@/lib/navigation";
import { RuleBuilderDialog } from "./rule-builder";
import { announceRuleOutcomes } from "./announce";
import { useRulesSource } from "./source";

const EMPTY: NewRule = {
  type: "structured",
  name: "",
  enabled: true,
  priority: 1,
  match: "all",
  conditions: [{ field: "flag", op: "has", value: "screenshot" }],
  actions: [{ type: "move", value: "Temp" }],
  createdBy: "user",
  createdAt: 0,
  mode: "suggest",
  schedule: "none",
};

function describe(rule: Rule, t: TFunction<"rules">, scopeName: (id: string) => string) {
  const conds = rule.conditions
    .map((c) => t("describe.condition", { field: t(`fields.${c.field}`).toLowerCase(), op: t(`ops.${c.op}`), value: c.field === "space" ? scopeName(c.value) : c.value }))
    .join(` ${rule.match === "all" ? t("describe.and") : t("describe.or")} `);
  const acts = rule.actions
    .map((a) => {
      const action = t(`actionTypes.${a.type}`).toLowerCase();
      return a.value ? t("describe.actionWithValue", { action, value: a.value }) : action;
    })
    .join(", ");
  return t("describe.summary", { conditions: conds || "…", actions: acts || "…" });
}

/** Rules for whatever is open: folders on this device or the organization's server spaces (same UI). */
export function RulesPage() {
  const { t } = useTranslation("rules");
  const source = useRulesSource();
  const rules = source.rules ?? [];
  const [editing, setEditing] = useState<NewRule | Rule | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const [natural, setNatural] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const structured = rules.filter((r) => r.type === "structured");
  const naturalRules = rules.filter((r) => r.type === "natural");
  const scopeName = (id: string) => source.scopes.find((s) => s.id === id)?.name ?? id;
  const ro = !source.canManage;

  const run = async (ruleId?: Rule["id"]) => {
    setBusy(`run:${ruleId ?? "all"}`);
    try {
      const summary = await source.run(ruleId);
      if (!summary) return;
      if (summary.singlePlanId !== undefined) setPlanId(summary.singlePlanId);
      else announceRuleOutcomes(summary.outcomes, { openApprovals: () => navigateTo("/approvals") });
    } finally {
      setBusy(null);
    }
  };
  const move = async (rule: Rule, dir: -1 | 1) => {
    const list = [...structured];
    const i = list.findIndex((r) => r.id === rule.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    await source.reorder(list);
  };
  const convert = async (rule: Rule) => {
    setBusy(`convert:${rule.id}`);
    try {
      const proposal = await source.convert(rule.naturalText ?? rule.name);
      if (proposal) setEditing({ ...proposal, priority: structured.length + 1 });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-4xl space-y-8">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Workflow className="size-4 text-accent" />
            <h1 className="font-semibold">{t("page.title")}</h1>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void run()} disabled={!source.ready || !structured.some((r) => r.enabled) || busy !== null}>
                <Play />
                {t("page.runAll")}
              </Button>
              <Button size="sm" onClick={() => setEditing({ ...EMPTY, priority: structured.length + 1 })} disabled={ro}>
                <Plus />
                {t("page.newRule")}
              </Button>
            </div>
            <p className="w-full text-xs text-muted">{t("page.intro")}</p>
            {ro && <p className="w-full text-xs text-warning">{t("page.viewOnly")}</p>}
          </div>
          {source.rules && structured.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted">{t("page.empty")}</p>}
          {structured.map((rule, i) => (
            <div key={rule.id} className={cn("flex items-center gap-3 rounded-lg border bg-surface p-3", !rule.enabled && "opacity-60")} data-testid="rule-row">
              <input
                type="checkbox"
                checked={rule.enabled}
                disabled={ro}
                onChange={(e) => void source.setEnabled(rule, e.target.checked)}
                className="size-4 accent-[rgb(var(--accent))]"
                aria-label={t("page.enableRule", { name: rule.name })}
              />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  {rule.name}
                  <span className={cn("rounded-full px-1.5 py-px text-[11px] font-medium", rule.mode === "auto" ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")}>
                    {rule.mode === "auto" && <Zap className="mr-0.5 inline size-3" />}
                    {t(`modes.${rule.mode ?? "suggest"}`)}
                  </span>
                  {rule.schedule && rule.schedule !== "none" && (
                    <span className="rounded-full bg-surface-2 px-1.5 py-px text-[11px] font-normal text-muted">
                      <CalendarClock className="mr-0.5 inline size-3" />
                      {t(`schedules.${rule.schedule}`)}
                      {rule.lastRunAt ? ` · ${t("page.lastRun", { when: formatDate(rule.lastRunAt) })}` : ""}
                    </span>
                  )}
                  {rule.scopeSpaceId !== undefined && <span className="text-[11px] font-normal text-muted">· {scopeName(String(rule.scopeSpaceId))}</span>}
                  {rule.createdBy === "agent" && <span className="text-xs font-normal text-muted">{t("page.byAgent")}</span>}
                </p>
                <p className="truncate text-xs text-muted" title={describe(rule, t, scopeName)}>
                  {describe(rule, t, scopeName)}
                </p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => void move(rule, -1)} disabled={ro || i === 0} aria-label={t("page.moveUp")}>
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void move(rule, 1)} disabled={ro || i === structured.length - 1} aria-label={t("page.moveDown")}>
                <ArrowDown />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(rule)} title={t("page.editTestTitle")}>
                <Pencil />
                {t("page.editTest")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void run(rule.id)} disabled={!source.ready || busy !== null}>
                <Play />
                {t("page.run")}
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void source.archive(rule)} disabled={ro} aria-label={t("page.deleteRule", { name: rule.name })}>
                <Archive />
              </Button>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <MessageSquareText className="size-4 text-accent" />
            <h2 className="font-semibold">{t("natural.title")}</h2>
            <span className="text-xs text-muted">{t("natural.intro")}</span>
          </div>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const text = natural.trim();
              if (!text) return;
              const ok = await source.save({ type: "natural", name: text.slice(0, 60), enabled: true, priority: 1000, match: "all", conditions: [], actions: [], naturalText: text, createdBy: "user", createdAt: Date.now() });
              if (ok) setNatural("");
            }}
          >
            <input
              value={natural}
              onChange={(e) => setNatural(e.target.value)}
              placeholder={t("natural.placeholder")}
              className="h-9 flex-1 rounded-lg border bg-surface px-3 text-sm"
              aria-label={t("natural.inputLabel")}
              disabled={ro}
            />
            <Button type="submit" disabled={ro || !natural.trim()}>
              {t("natural.add")}
            </Button>
          </form>
          {naturalRules.map((rule) => (
            <div key={rule.id} className={cn("flex items-center gap-3 rounded-lg border bg-surface p-3", !rule.enabled && "opacity-60")}>
              <input
                type="checkbox"
                checked={rule.enabled}
                disabled={ro}
                onChange={(e) => void source.setEnabled(rule, e.target.checked)}
                className="size-4 accent-[rgb(var(--accent))]"
                aria-label={t("natural.enable")}
              />
              <p className="min-w-0 flex-1 text-sm">{rule.naturalText}</p>
              <Button variant="outline" size="sm" onClick={() => void convert(rule)} disabled={ro || busy === `convert:${rule.id}`}>
                <Sparkles />
                {busy === `convert:${rule.id}` ? t("natural.converting") : t("natural.convert")}
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void source.archive(rule)} disabled={ro} aria-label={t("natural.delete")}>
                <Archive />
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
