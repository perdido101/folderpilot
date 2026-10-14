import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowDown, ArrowUp, MessageSquareText, Pencil, Play, Plus, Sparkles, Trash2, Workflow } from "lucide-react";
import { Button } from "@folderpilot/ui";
import { db } from "@/lib/db";
import { proposeRules } from "@/lib/actions/organize";
import { runAgentTurn } from "@/lib/agent/agent";
import type { NewRule, Rule } from "@folderpilot/core";
import { deleteRule, logRuleChange } from "@/lib/rules/store";
import { useSettings } from "@/lib/settings";
import { cn } from "@folderpilot/ui";
import { PlanDialog } from "@/features/plans/plan-card";
import { useActiveRoot } from "@/hooks/use-active-root";
import { toast } from "@/stores/toasts";
import { RuleBuilderDialog } from "./rule-builder";

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
};

function describe(rule: Rule, t: TFunction<"rules">) {
  const conds = rule.conditions
    .map((c) => t("describe.condition", { field: t(`fields.${c.field}`).toLowerCase(), op: t(`ops.${c.op}`), value: c.value }))
    .join(` ${rule.match === "all" ? t("describe.and") : t("describe.or")} `);
  const acts = rule.actions
    .map((a) => {
      const action = t(`actionTypes.${a.type}`).toLowerCase();
      return a.value ? t("describe.actionWithValue", { action, value: a.value }) : action;
    })
    .join(", ");
  return t("describe.summary", { conditions: conds || "…", actions: acts || "…" });
}

export function RulesPage() {
  const root = useActiveRoot();
  const { t } = useTranslation("rules");
  const rules = useLiveQuery(() => db.rules.orderBy("priority").toArray(), []) ?? [];
  const settings = useSettings();
  const [editing, setEditing] = useState<NewRule | Rule | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const [natural, setNatural] = useState("");
  const [converting, setConverting] = useState<Rule["id"] | null>(null);
  const structured = rules.filter((r) => r.type === "structured");
  const naturalRules = rules.filter((r) => r.type === "natural");
  const rootId = root?.id ?? 0;

  const propose = async (ruleId?: Rule["id"]) => {
    if (!root) return toast(t("toasts.openFolder"));
    const id = await proposeRules(root.id, ruleId);
    if (id === null) toast(t("toasts.noMatches"));
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
    if (settings.ai.provider === "none") return toast(t("toasts.connectAI"));
    setConverting(rule.id);
    try {
      const turn = await runAgentTurn(
        root.id,
        [],
        `Convert this natural-language rule into ONE structured rule with create_rule. Do not propose any other changes.\nRule: ${rule.naturalText}`,
      );
      if (turn.planIds[0]) setPlanId(turn.planIds[0]);
      else toast(turn.reply || t("toasts.convertFailed"), "error");
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
            <h1 className="font-semibold">{t("page.title")}</h1>
            <span className="text-xs text-muted">{t("page.intro")}</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void propose()} disabled={!structured.some((r) => r.enabled)}>
                <Play />
                {t("page.runAll")}
              </Button>
              <Button size="sm" onClick={() => setEditing({ ...EMPTY, priority: structured.length + 1 })}>
                <Plus />
                {t("page.newRule")}
              </Button>
            </div>
          </div>
          {structured.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted">{t("page.empty")}</p>}
          {structured.map((rule, i) => (
            <div key={rule.id} className={cn("flex items-center gap-3 rounded-lg border bg-surface p-3", !rule.enabled && "opacity-60")}>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => void logRuleChange({ ...rule, enabled: e.target.checked }, rootId)}
                className="size-4 accent-[rgb(var(--accent))]"
                aria-label={t("page.enableRule", { name: rule.name })}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {rule.name} {rule.createdBy === "agent" && <span className="text-xs font-normal text-muted">{t("page.byAgent")}</span>}
                </p>
                <p className="truncate text-xs text-muted" title={describe(rule, t)}>
                  {describe(rule, t)}
                </p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => void move(rule, -1)} disabled={i === 0} aria-label={t("page.moveUp")}>
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void move(rule, 1)} disabled={i === structured.length - 1} aria-label={t("page.moveDown")}>
                <ArrowDown />
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(rule)} title={t("page.editTestTitle")}>
                <Pencil />
                {t("page.editTest")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void propose(rule.id)}>
                <Play />
                {t("page.run")}
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void deleteRule(rule, rootId)} aria-label={t("page.deleteRule", { name: rule.name })}>
                <Trash2 />
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
              if (!natural.trim()) return;
              await logRuleChange(
                {
                  type: "natural",
                  name: natural.trim().slice(0, 60),
                  enabled: true,
                  priority: 1000,
                  match: "all",
                  conditions: [],
                  actions: [],
                  naturalText: natural.trim(),
                  createdBy: "user",
                  createdAt: Date.now(),
                },
                rootId,
              );
              setNatural("");
            }}
          >
            <input
              value={natural}
              onChange={(e) => setNatural(e.target.value)}
              placeholder={t("natural.placeholder")}
              className="h-9 flex-1 rounded-lg border bg-surface px-3 text-sm"
              aria-label={t("natural.inputLabel")}
            />
            <Button type="submit" disabled={!natural.trim()}>
              {t("natural.add")}
            </Button>
          </form>
          {naturalRules.map((rule) => (
            <div key={rule.id} className={cn("flex items-center gap-3 rounded-lg border bg-surface p-3", !rule.enabled && "opacity-60")}>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => void logRuleChange({ ...rule, enabled: e.target.checked }, rootId)}
                className="size-4 accent-[rgb(var(--accent))]"
                aria-label={t("natural.enable")}
              />
              <p className="min-w-0 flex-1 text-sm">{rule.naturalText}</p>
              <Button variant="outline" size="sm" onClick={() => void convert(rule)} disabled={converting === rule.id}>
                <Sparkles />
                {converting === rule.id ? t("natural.converting") : t("natural.convert")}
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void deleteRule(rule, rootId)} aria-label={t("natural.delete")}>
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
