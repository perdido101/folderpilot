import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";
import { Button } from "@folderpilot/ui";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@folderpilot/ui";
import { Input } from "@folderpilot/ui";
import { db } from "@/lib/db";
import { dryRun } from "@folderpilot/core";
import { OPS_BY_FIELD, type ActionType, type Condition, type ConditionField, type NewRule, type Rule } from "@folderpilot/core";
import { logRuleChange } from "@/lib/rules/store";
import { useActiveRoot } from "@/hooks/use-active-root";
import { toast } from "@/stores/toasts";

const selectCls = "h-9 rounded-lg border bg-surface px-2 text-sm";

const FIELDS: ConditionField[] = ["ext", "kind", "name", "content", "date", "size", "folder", "category", "flag", "tag"];
const ACTIONS: ActionType[] = ["move", "rename", "tag", "caption", "set_category", "flag_review"];

/** Example values. Literal ones are file data (extensions, kinds, flags, dates); the rest are translated. */
const PLACEHOLDER: Record<ConditionField, string | { key: "content" | "category" | "tag" }> = {
  ext: "png, jpg",
  kind: "image",
  name: "screenshot",
  content: { key: "content" },
  date: "2024-01-01",
  size: "10",
  folder: "Downloads",
  category: { key: "category" },
  flag: "screenshot",
  tag: { key: "tag" },
};

/** Visual IF → THEN rule builder with a live dry-run count. Saving a user rule is logged. */
export function RuleBuilderDialog({ initial, onClose }: { initial: NewRule | Rule; onClose: () => void }) {
  const root = useActiveRoot();
  const { t } = useTranslation(["rules", "common"]);
  const files = useLiveQuery(() => (root ? db.files.where("rootId").equals(root.id).toArray() : []), [root?.id]);
  const [rule, setRule] = useState<NewRule | Rule>(initial);
  const test = useMemo(() => dryRun(files ?? [], { ...rule, id: "id" in rule ? rule.id : -1 }), [files, rule]);

  const placeholderFor = (field: ConditionField) => {
    const p = PLACEHOLDER[field];
    return typeof p === "string" ? p : t(`builder.placeholders.${p.key}`);
  };
  const setCond = (i: number, patch: Partial<Condition>) => setRule({ ...rule, conditions: rule.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const save = async () => {
    if (!rule.name.trim() || !rule.conditions.length || !rule.actions.length) {
      toast(t("toasts.incomplete"), "error");
      return;
    }
    await logRuleChange(rule, root?.id ?? 0);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" onKeyDown={(e) => e.stopPropagation()}>
        <DialogTitle>{"id" in rule ? t("builder.editTitle") : t("builder.newTitle")}</DialogTitle>
        <DialogDescription>{t("builder.description")}</DialogDescription>
        <Input
          value={rule.name}
          onChange={(e) => setRule({ ...rule, name: e.target.value })}
          placeholder={t("builder.namePlaceholder")}
          aria-label={t("builder.nameLabel")}
        />

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            {t("builder.if")}
            <select
              className={selectCls}
              value={rule.match}
              onChange={(e) => setRule({ ...rule, match: e.target.value as "all" | "any" })}
              aria-label={t("builder.matchLabel")}
            >
              <option value="all">{t("builder.matchAll")}</option>
              <option value="any">{t("builder.matchAny")}</option>
            </select>
            {t("builder.ofTheseAreTrue")}
          </div>
          {rule.conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                className={selectCls}
                value={c.field}
                onChange={(e) => setCond(i, { field: e.target.value as ConditionField, op: OPS_BY_FIELD[e.target.value as ConditionField][0]! })}
                aria-label={t("builder.fieldLabel")}
              >
                {FIELDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`fields.${k}`)}
                  </option>
                ))}
              </select>
              <select
                className={selectCls}
                value={c.op}
                onChange={(e) => setCond(i, { op: e.target.value as Condition["op"] })}
                aria-label={t("builder.operatorLabel")}
              >
                {OPS_BY_FIELD[c.field].map((op) => (
                  <option key={op} value={op}>
                    {t(`ops.${op}`)}
                  </option>
                ))}
              </select>
              <Input
                className="w-48 flex-1"
                value={c.value}
                onChange={(e) => setCond(i, { value: e.target.value })}
                placeholder={placeholderFor(c.field)}
                type={c.field === "date" && c.op !== "within_days" ? "date" : "text"}
                aria-label={t("builder.valueLabel")}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setRule({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })}
                aria-label={t("builder.removeCondition")}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setRule({ ...rule, conditions: [...rule.conditions, { field: "ext", op: "is", value: "" }] })}>
            <Plus />
            {t("builder.addCondition")}
          </Button>
        </section>

        <section className="space-y-2">
          <p className="text-sm font-medium">{t("builder.then")}</p>
          {rule.actions.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                className={selectCls}
                value={a.type}
                onChange={(e) => setRule({ ...rule, actions: rule.actions.map((x, j) => (j === i ? { ...x, type: e.target.value as ActionType } : x)) })}
                aria-label={t("builder.actionLabel")}
              >
                {ACTIONS.map((k) => (
                  <option key={k} value={k}>
                    {t(`actionTypes.${k}`)}
                  </option>
                ))}
              </select>
              {a.type !== "flag_review" && (
                <Input
                  className="w-48 flex-1"
                  value={a.value}
                  onChange={(e) => setRule({ ...rule, actions: rule.actions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  placeholder={
                    a.type === "move"
                      ? "Temp/{year}"
                      : a.type === "rename"
                        ? "{date} {name}"
                        : a.type === "tag"
                          ? "screenshot"
                          : a.type === "set_category"
                            ? t("builder.placeholders.setCategory")
                            : t("builder.placeholders.caption")
                  }
                  aria-label={t("builder.actionValueLabel")}
                />
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setRule({ ...rule, actions: rule.actions.filter((_, j) => j !== i) })}
                aria-label={t("builder.removeAction")}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setRule({ ...rule, actions: [...rule.actions, { type: "move", value: "" }] })}>
            <Plus />
            {t("builder.addAction")}
          </Button>
          <p className="text-xs text-muted">{t("builder.variables", { vars: "{year} {month} {date} {category} {client} {type} {name} {ext}" })}</p>
        </section>

        <section className="rounded-lg border bg-surface-2/50 p-3">
          <p className="text-sm font-medium">
            {t("builder.test", { matches: t("builder.matches", { count: test.matches.length }), changes: t("builder.changes", { count: test.steps.length }) })}
          </p>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto font-mono text-[11px] text-muted">
            {test.steps.slice(0, 20).map((s, i) => (
              <li key={i} className="truncate">
                {s.action}: {s.before} → <span className="text-text">{s.after ?? s.to}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={save}>{t("builder.save")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
