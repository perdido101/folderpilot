import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowRight, Check, ListChecks, Pencil, RotateCw, SkipForward, X } from "lucide-react";
import { Button } from "@folderpilot/ui";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@folderpilot/ui";
import { db, type PlanRecord, type PlanStep } from "@/lib/db";
import { cancelPlan, describeSteps, resolveConflict, updatePlanSteps } from "@/lib/actions/engine";
import { approvePlan, showResult } from "@/lib/actions/user-actions";
import { toast } from "@/stores/toasts";
import { cn } from "@folderpilot/ui";

export function StepRow({ step, names }: { step: PlanStep; names: Map<number, string> }) {
  const { t } = useTranslation(["plans", "common"]);
  const name = step.fileId !== undefined ? names.get(step.fileId) : undefined;
  const isPath = step.action === "move" || step.action === "rename" || step.action === "trash" || step.action === "restore";
  return (
    <div className="flex items-start gap-2 py-1.5 text-xs">
      <span className="mt-0.5 w-16 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-center font-medium text-muted" title={step.undoes !== undefined ? t(`stepLabels.${step.action}`) : undefined}>
        {step.undoes !== undefined ? t("stepLabels.undo") : t(`stepLabels.${step.action}`)}
      </span>
      <div className="min-w-0 flex-1">
        {name && !isPath && <p className="truncate font-medium">{name}</p>}
        <p className={cn("truncate text-muted", isPath && "font-mono text-[11px]")} title={step.before}>
          {step.before ?? "—"}
        </p>
        <p className={cn("flex min-w-0 items-center gap-1", isPath && "font-mono text-[11px]")} title={step.after ?? step.to}>
          <ArrowRight className="size-3 shrink-0 text-accent" />
          <span className="truncate">{step.after ?? step.to ?? "—"}</span>
        </p>
      </div>
    </div>
  );
}

function useFileNames(steps: PlanStep[]) {
  const ids = steps.flatMap((s) => (s.fileId !== undefined ? [s.fileId] : []));
  const files = useLiveQuery(() => db.files.bulkGet(ids), [ids.join()]);
  return new Map((files ?? []).flatMap((f) => (f ? [[f.id, f.name] as const] : [])));
}

const fileCount = (steps: PlanStep[]) => new Set(steps.map((s) => s.fileId).filter((x) => x !== undefined)).size;

/** "user" / "agent" / "rule:<id>" → a translated name; anything else is shown as-is. */
function useActorLabel() {
  const { t } = useTranslation(["plans", "common"]);
  return (actor: string) => {
    if (actor === "user" || actor.startsWith("user:")) return t("actors.user");
    if (actor === "agent" || actor.startsWith("agent:")) return t("actors.agent");
    if (actor === "rule" || actor.startsWith("rule:")) return t("actors.rule");
    if (actor.startsWith("mcp:")) return t("actors.mcp", { client: actor.split(":")[1] });
    return actor;
  };
}

/** Summary, file count, before/after preview and Approve / Edit / Cancel. Nothing touches disk before Approve. */
export function PlanCard({ planId, compact = false }: { planId: number; compact?: boolean }) {
  const plan = useLiveQuery(() => db.plans.get(planId), [planId]);
  const names = useFileNames(plan?.steps ?? []);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation(["plans", "common"]);
  const actorLabel = useActorLabel();
  if (!plan) return null;
  const preview = plan.steps.slice(0, compact ? 3 : 5);
  const files = fileCount(plan.steps);

  return (
    <div className={cn("rounded-lg border bg-surface", plan.status === "pending" && "border-accent/40")}>
      <div className="flex items-start gap-2 border-b px-3 py-2">
        <ListChecks className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{plan.summary}</p>
          <p className="text-xs text-muted">
            {describeSteps(plan.steps)}
            {files > 0 && ` · ${t("common:file", { count: files })}`} · {t("by", { actor: actorLabel(plan.actor) })}
          </p>
        </div>
        <StatusBadge plan={plan} />
      </div>
      <div className="divide-y px-3">
        {preview.map((s, i) => (
          <StepRow key={i} step={s} names={names} />
        ))}
        {plan.steps.length > preview.length && <p className="py-1.5 text-xs text-muted">{t("more", { count: plan.steps.length - preview.length })}</p>}
      </div>
      {plan.status === "executing" && <Progress plan={plan} />}
      <Problems plan={plan} names={names} />
      {plan.errors && plan.errors.length > 0 && !plan.steps.some((s) => s.error) && (
        <p className="border-t px-3 py-2 text-xs text-danger">{t("failed", { count: plan.errors.length, error: plan.errors[0] })}</p>
      )}
      {plan.status === "pending" && (
        <div className="flex gap-2 border-t p-2">
          <Button
            size="sm"
            disabled={busy || plan.steps.length === 0}
            onClick={async () => {
              setBusy(true);
              await approvePlan(plan.id);
              setBusy(false);
            }}
          >
            <Check />
            {t("common:actions.approve")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil />
            {t("common:actions.edit")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void cancelPlan(plan.id)}>
            <X />
            {t("common:actions.cancel")}
          </Button>
        </div>
      )}
      <PlanEditDialog key={`${plan.steps.length}-${editing}`} plan={plan} names={names} open={editing} onOpenChange={setEditing} />
    </div>
  );
}

function Progress({ plan }: { plan: PlanRecord }) {
  const { t } = useTranslation("plans");
  const done = plan.steps.filter((s) => s.status !== "pending").length;
  return (
    <div className="border-t px-3 py-2" role="status">
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full bg-accent transition-[width] duration-150 ease-out" style={{ width: `${(done / Math.max(1, plan.steps.length)) * 100}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted">{t("progress", { done, total: plan.steps.length })}</p>
    </div>
  );
}

/** Steps that hit a conflict (file changed or moved since the plan was made) or failed: skip, or apply to the file as it is now. */
function Problems({ plan, names }: { plan: PlanRecord; names: Map<number, string> }) {
  const { t } = useTranslation(["plans", "common"]);
  const [busy, setBusy] = useState(false);
  const problems = plan.steps.filter((s) => s.status === "conflicted" || s.status === "failed");
  if (plan.status === "executing" || problems.length === 0) return null;
  const resolve = async (seq: number, choice: "skip" | "retry") => {
    setBusy(true);
    try {
      const res = await resolveConflict(plan.id, seq, choice);
      if (res) showResult(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <AlertTriangle className="size-3.5" />
        {t("problems.title", { count: problems.length })}
      </p>
      <ul className="divide-y">
        {problems.slice(0, 10).map((s) => (
          <li key={s.seq} className="py-1">
            <StepRow step={s} names={names} />
            <p className="pl-[4.5rem] text-xs text-danger">{s.error}</p>
            <div className="flex gap-2 pl-[4.5rem] pt-1">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void resolve(s.seq, "retry")}>
                <RotateCw />
                {s.status === "conflicted" ? t("problems.applyAnyway") : t("problems.retry")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void resolve(s.seq, "skip")}>
                <SkipForward />
                {t("problems.skip")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {problems.length > 10 && <p className="py-1 text-xs text-muted">{t("more", { count: problems.length - 10 })}</p>}
    </div>
  );
}

function StatusBadge({ plan }: { plan: PlanRecord }) {
  const { t } = useTranslation(["plans", "common"]);
  const styles: Record<PlanRecord["status"], string> = {
    pending: "bg-accent-soft text-accent",
    approved: "bg-surface-2 text-muted",
    executing: "bg-accent-soft text-accent",
    executed: "bg-success/10 text-success",
    partially_failed: "bg-warning/10 text-warning",
    cancelled: "bg-surface-2 text-muted line-through",
  };
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", styles[plan.status])}>{t(`status.${plan.status}`)}</span>;
}

/** Untick steps you don't want, then save. */
function PlanEditDialog({
  plan,
  names,
  open,
  onOpenChange,
}: {
  plan: PlanRecord;
  names: Map<number, string>;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [keep, setKeep] = useState<Set<number>>(() => new Set(plan.steps.map((_, i) => i)));
  const { t } = useTranslation(["plans", "common"]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
        <DialogTitle>{t("edit.title")}</DialogTitle>
        <DialogDescription>{t("edit.description")}</DialogDescription>
        <div className="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border px-3">
          {plan.steps.map((s, i) => (
            <label key={i} className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                className="size-4 accent-[rgb(var(--accent))]"
                checked={keep.has(i)}
                onChange={(e) => {
                  const next = new Set(keep);
                  if (e.target.checked) next.add(i);
                  else next.delete(i);
                  setKeep(next);
                }}
              />
              <div className="min-w-0 flex-1">
                <StepRow step={s} names={names} />
              </div>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:actions.close")}
          </Button>
          <Button
            onClick={async () => {
              await updatePlanSteps(
                plan.id,
                plan.steps.filter((_, i) => keep.has(i)),
              );
              onOpenChange(false);
            }}
          >
            {t("edit.save", { count: keep.size })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A dialog that shows one plan card, used for rule runs and "Organize". */
export function PlanDialog({ planId, onClose }: { planId: number | null; onClose: () => void }) {
  const plan = useLiveQuery(() => (planId ? db.plans.get(planId) : undefined), [planId]);
  const { t } = useTranslation(["plans", "common"]);
  return (
    <Dialog open={planId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t("review.title")}</DialogTitle>
        <DialogDescription>{t("review.description")}</DialogDescription>
        {planId !== null && <PlanCard planId={planId} />}
        {plan && plan.status !== "pending" && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              {t("common:actions.done")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
