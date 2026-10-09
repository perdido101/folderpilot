import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { db } from "@/lib/db";
import { dryRun } from "@/lib/rules/evaluate";
import { ACTION_LABELS, FIELD_LABELS, OP_LABELS, OPS_BY_FIELD, type ActionType, type Condition, type ConditionField, type NewRule, type Rule } from "@/lib/rules/types";
import { logRuleChange } from "@/lib/rules/store";
import { useActiveRoot } from "@/hooks/use-active-root";
import { toast } from "@/stores/toasts";

const selectCls = "h-9 rounded-lg border bg-surface px-2 text-sm";

const PLACEHOLDER: Record<ConditionField, string> = {
  ext: "png, jpg",
  kind: "image",
  name: "screenshot",
  content: "invoice",
  date: "2024-01-01",
  size: "10",
  folder: "Downloads",
  category: "Invoices",
  flag: "screenshot",
  tag: "paid",
};

/** Visual IF → THEN rule builder with a live dry-run count. Saving a user rule is logged. */
export function RuleBuilderDialog({ initial, onClose }: { initial: NewRule | Rule; onClose: () => void }) {
  const root = useActiveRoot();
  const files = useLiveQuery(() => (root ? db.files.where("rootId").equals(root.id).toArray() : []), [root?.id]);
  const [rule, setRule] = useState<NewRule | Rule>(initial);
  const test = useMemo(() => dryRun(files ?? [], { ...rule, id: "id" in rule ? rule.id : -1 }), [files, rule]);

  const setCond = (i: number, patch: Partial<Condition>) => setRule({ ...rule, conditions: rule.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const save = async () => {
    if (!rule.name.trim() || !rule.conditions.length || !rule.actions.length) {
      toast("Give the rule a name, at least one condition and one action.", "error");
      return;
    }
    await logRuleChange(rule, root?.id ?? 0);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" onKeyDown={(e) => e.stopPropagation()}>
        <DialogTitle>{"id" in rule ? "Edit rule" : "New rule"}</DialogTitle>
        <DialogDescription>Rules never touch files on their own: running them creates a plan you approve.</DialogDescription>
        <Input value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} placeholder="Rule name, e.g. Screenshots to Temp" aria-label="Rule name" />

        <section className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            IF
            <select className={selectCls} value={rule.match} onChange={(e) => setRule({ ...rule, match: e.target.value as "all" | "any" })} aria-label="Match">
              <option value="all">all</option>
              <option value="any">any</option>
            </select>
            of these are true
          </div>
          {rule.conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select className={selectCls} value={c.field} onChange={(e) => setCond(i, { field: e.target.value as ConditionField, op: OPS_BY_FIELD[e.target.value as ConditionField][0]! })} aria-label="Field">
                {Object.entries(FIELD_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
              <select className={selectCls} value={c.op} onChange={(e) => setCond(i, { op: e.target.value as Condition["op"] })} aria-label="Operator">
                {OPS_BY_FIELD[c.field].map((op) => (
                  <option key={op} value={op}>
                    {OP_LABELS[op]}
                  </option>
                ))}
              </select>
              <Input className="w-48 flex-1" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder={PLACEHOLDER[c.field]} type={c.field === "date" && c.op !== "within_days" ? "date" : "text"} aria-label="Value" />
              <Button variant="ghost" size="icon-sm" onClick={() => setRule({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })} aria-label="Remove condition">
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setRule({ ...rule, conditions: [...rule.conditions, { field: "ext", op: "is", value: "" }] })}>
            <Plus />
            Condition
          </Button>
        </section>

        <section className="space-y-2">
          <p className="text-sm font-medium">THEN</p>
          {rule.actions.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                className={selectCls}
                value={a.type}
                onChange={(e) => setRule({ ...rule, actions: rule.actions.map((x, j) => (j === i ? { ...x, type: e.target.value as ActionType } : x)) })}
                aria-label="Action"
              >
                {Object.entries(ACTION_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
              {a.type !== "flag_review" && (
                <Input
                  className="w-48 flex-1"
                  value={a.value}
                  onChange={(e) => setRule({ ...rule, actions: rule.actions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  placeholder={a.type === "move" ? "Temp/{year}" : a.type === "rename" ? "{date} {name}" : a.type === "tag" ? "screenshot" : a.type === "set_category" ? "Screenshots" : "Caption"}
                  aria-label="Action value"
                />
              )}
              <Button variant="ghost" size="icon-sm" onClick={() => setRule({ ...rule, actions: rule.actions.filter((_, j) => j !== i) })} aria-label="Remove action">
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setRule({ ...rule, actions: [...rule.actions, { type: "move", value: "" }] })}>
            <Plus />
            Action
          </Button>
          <p className="text-xs text-muted">Variables: {"{year} {month} {date} {category} {client} {type} {name} {ext}"}</p>
        </section>

        <section className="rounded-lg border bg-surface-2/50 p-3">
          <p className="text-sm font-medium">
            Test: {test.matches.length} file{test.matches.length === 1 ? "" : "s"} match · {test.steps.length} change{test.steps.length === 1 ? "" : "s"}
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
            Cancel
          </Button>
          <Button onClick={save}>Save rule</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
