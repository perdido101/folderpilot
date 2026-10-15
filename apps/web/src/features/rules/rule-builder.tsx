import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogTitle, Input } from "@folderpilot/ui";
import { OPS_BY_FIELD, regexProblem, ruleProblem, type ActionType, type Condition, type ConditionField, type NewRule, type Rule, type RuleMode, type RuleSchedule } from "@folderpilot/core";
import { toast } from "@/stores/toasts";
import { useRulesSource, type RulesSource } from "./source";
import type { RulePreview } from "./server-api";

const selectCls = "h-9 rounded-lg border bg-surface px-2 text-sm";

const FIELDS: ConditionField[] = ["ext", "kind", "name", "content", "date", "size", "folder", "category", "client", "docType", "flag", "tag", "space"];
const ACTIONS: ActionType[] = ["move", "rename", "tag", "caption", "set_category", "flag_review"];
const SCHEDULES: RuleSchedule[] = ["none", "hourly", "daily", "weekly"];

/** Example values. Literal ones are file data (extensions, kinds, flags, dates); the rest are translated. */
const PLACEHOLDER: Record<Exclude<ConditionField, "space">, string | { key: "content" | "category" | "tag" | "client" | "docType" }> = {
  ext: "png, jpg",
  kind: "image",
  name: "screenshot",
  content: { key: "content" },
  date: "2024-01-01",
  size: "10",
  folder: "Downloads",
  category: { key: "category" },
  client: { key: "client" },
  docType: { key: "docType" },
  flag: "screenshot",
  tag: { key: "tag" },
};

/** Debounced dry-run of the rule being edited (nothing changes). */
function usePreview(source: RulesSource, rule: NewRule | Rule) {
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify({ ...rule, name: "" });
  useEffect(() => {
    if (ruleProblem({ ...rule, name: rule.name || "x" })) {
      setPreview(null);
      return;
    }
    let live = true;
    const id = window.setTimeout(() => {
      source
        .preview(rule)
        .then((p) => live && (setPreview(p), setError(null)))
        .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [key, source.kind]);
  return { preview, error };
}

/** Visual IF → THEN rule builder with mode, scope, schedule and a live dry-run. Works for this device and server spaces. */
export function RuleBuilderDialog({ initial, onClose }: { initial: NewRule | Rule; onClose: () => void }) {
  const source = useRulesSource();
  const { t } = useTranslation(["rules", "common", "plans"]);
  const [rule, setRule] = useState<NewRule | Rule>({ mode: "suggest", schedule: "none", ...initial });
  const [saving, setSaving] = useState(false);
  const { preview, error } = usePreview(source, rule);
  const scopeName = (id: string) => source.scopes.find((s) => s.id === id)?.name ?? id;

  const placeholderFor = (field: ConditionField) => {
    if (field === "space") return "";
    const p = PLACEHOLDER[field];
    return typeof p === "string" ? p : t(`builder.placeholders.${p.key}`);
  };
  const setCond = (i: number, patch: Partial<Condition>) => setRule({ ...rule, conditions: rule.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const autoLocked = !source.canAuto && (initial.mode ?? "suggest") !== "auto";

  const save = async () => {
    const problem = ruleProblem(rule);
    if (problem) {
      toast(problem, "error");
      return;
    }
    setSaving(true);
    const ok = await source.save(rule);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" onKeyDown={(e) => e.stopPropagation()}>
        <DialogTitle>{"id" in rule ? t("builder.editTitle") : t("builder.newTitle")}</DialogTitle>
        <DialogDescription>{rule.mode === "auto" ? t("builder.descriptionAuto") : t("builder.description")}</DialogDescription>
        <Input value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} placeholder={t("builder.namePlaceholder")} aria-label={t("builder.nameLabel")} />

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            {t("builder.if")}
            <select className={selectCls} value={rule.match} onChange={(e) => setRule({ ...rule, match: e.target.value as "all" | "any" })} aria-label={t("builder.matchLabel")}>
              <option value="all">{t("builder.matchAll")}</option>
              <option value="any">{t("builder.matchAny")}</option>
            </select>
            {t("builder.ofTheseAreTrue")}
          </div>
          {rule.conditions.map((c, i) => {
            const regexError = c.op === "matches" && c.value ? regexProblem(c.value) : null;
            return (
              <div key={i} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className={selectCls}
                    value={c.field}
                    onChange={(e) => {
                      const field = e.target.value as ConditionField;
                      setCond(i, { field, op: OPS_BY_FIELD[field][0]!, value: field === "space" ? (source.scopes[0]?.id ?? "") : c.value });
                    }}
                    aria-label={t("builder.fieldLabel")}
                  >
                    {FIELDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`fields.${k}`)}
                      </option>
                    ))}
                  </select>
                  <select className={selectCls} value={c.op} onChange={(e) => setCond(i, { op: e.target.value as Condition["op"] })} aria-label={t("builder.operatorLabel")}>
                    {OPS_BY_FIELD[c.field].map((op) => (
                      <option key={op} value={op}>
                        {t(`ops.${op}`)}
                      </option>
                    ))}
                  </select>
                  {c.field === "space" ? (
                    <select className={cn(selectCls, "flex-1")} value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} aria-label={t("builder.valueLabel")}>
                      {source.scopes.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      className={cn("w-48 flex-1", (c.op === "matches" || c.field === "name") && "font-mono", regexError && "border-danger")}
                      value={c.value}
                      onChange={(e) => setCond(i, { value: e.target.value })}
                      placeholder={c.op === "matches" ? "^IMG_\\d+" : placeholderFor(c.field)}
                      type={c.field === "date" && c.op !== "within_days" ? "date" : "text"}
                      aria-label={t("builder.valueLabel")}
                      aria-invalid={Boolean(regexError)}
                    />
                  )}
                  <Button variant="ghost" size="icon-sm" onClick={() => setRule({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })} aria-label={t("builder.removeCondition")}>
                    <Trash2 />
                  </Button>
                </div>
                {regexError && (
                  <p className="text-xs text-danger" role="alert">
                    {regexError}
                  </p>
                )}
              </div>
            );
          })}
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
                      ? "Clients/{client}/{year}"
                      : a.type === "rename"
                        ? "{date} {docType} {name}"
                        : a.type === "tag"
                          ? "screenshot"
                          : a.type === "set_category"
                            ? t("builder.placeholders.setCategory")
                            : t("builder.placeholders.caption")
                  }
                  aria-label={t("builder.actionValueLabel")}
                />
              )}
              <Button variant="ghost" size="icon-sm" onClick={() => setRule({ ...rule, actions: rule.actions.filter((_, j) => j !== i) })} aria-label={t("builder.removeAction")}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setRule({ ...rule, actions: [...rule.actions, { type: "move", value: "" }] })}>
            <Plus />
            {t("builder.addAction")}
          </Button>
          <p className="text-xs text-muted">{t("builder.variables", { vars: "{year} {month} {date} {category} {client} {docType} {type} {name} {ext}" })}</p>
        </section>

        <section className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs font-medium">
            <span>{t("builder.mode")}</span>
            <select
              className={cn(selectCls, "w-full")}
              value={rule.mode ?? "suggest"}
              onChange={(e) => setRule({ ...rule, mode: e.target.value as RuleMode })}
              aria-label={t("builder.mode")}
            >
              <option value="suggest">{t("modes.suggest")}</option>
              <option value="auto" disabled={autoLocked}>
                {t("modes.auto")}
              </option>
            </select>
            <span className="block font-normal text-muted">{autoLocked ? t("builder.autoAdminOnly") : t(`modeHints.${rule.mode ?? "suggest"}`)}</span>
          </label>
          <label className="space-y-1 text-xs font-medium">
            <span>{t("builder.scope")}</span>
            <select
              className={cn(selectCls, "w-full")}
              value={rule.scopeSpaceId === undefined ? "" : String(rule.scopeSpaceId)}
              onChange={(e) => {
                const { scopeSpaceId: _old, ...rest } = rule;
                setRule(e.target.value ? { ...rest, scopeSpaceId: e.target.value } : rest);
              }}
              aria-label={t("builder.scope")}
            >
              <option value="">{source.kind === "device" ? t("builder.scopeAllFolders") : t("builder.scopeAllSpaces")}</option>
              {source.scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium">
            <span>{t("builder.schedule")}</span>
            <select
              className={cn(selectCls, "w-full")}
              value={rule.schedule ?? "none"}
              onChange={(e) => setRule({ ...rule, schedule: e.target.value as RuleSchedule })}
              aria-label={t("builder.schedule")}
            >
              {SCHEDULES.map((s) => (
                <option key={s} value={s}>
                  {t(`schedules.${s}`)}
                </option>
              ))}
            </select>
            <span className="block font-normal text-muted">{t("builder.scheduleHint")}</span>
          </label>
        </section>

        <section className="rounded-lg border bg-surface-2/50 p-3" aria-live="polite">
          {!source.ready ? (
            <p className="text-sm text-muted">{t("builder.testNeedsFolder")}</p>
          ) : error ? (
            <p className="text-sm text-danger">{error}</p>
          ) : preview ? (
            <>
              <p className="text-sm font-medium" data-testid="rule-test-result">
                {t("builder.test", { matches: t("builder.matches", { count: preview.matches }), changes: t("builder.changes", { count: preview.changes }) })}
                {rule.scopeSpaceId !== undefined && <span className="font-normal text-muted"> · {scopeName(String(rule.scopeSpaceId))}</span>}
              </p>
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-[11px] text-muted">
                {preview.steps.map((s, i) => (
                  <li key={i} className="truncate">
                    <span className="font-medium text-text">{s.name}</span> · {t(`plans:stepLabels.${s.action}`, { defaultValue: s.action })}: <span className="font-mono">{s.before}</span> →{" "}
                    <span className="font-mono text-text">{s.after}</span>
                  </li>
                ))}
              </ul>
              {preview.changes > preview.steps.length && <p className="mt-1 text-[11px] text-muted">{t("builder.firstOnly", { count: preview.steps.length })}</p>}
            </>
          ) : (
            <p className="text-sm text-muted">{t("builder.testIncomplete")}</p>
          )}
        </section>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={save} disabled={saving || !source.canManage}>
            {t("builder.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
