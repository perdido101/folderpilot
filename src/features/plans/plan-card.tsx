import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowRight, Check, ListChecks, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { db, type PlanRecord, type PlanStep } from "@/lib/db";
import { cancelPlan, describeSteps, updatePlanSteps } from "@/lib/actions/engine";
import { approvePlan } from "@/lib/actions/user-actions";
import { cn } from "@/lib/utils";

const ACTION_LABEL: Record<PlanStep["action"], string> = {
  move: "Move",
  rename: "Rename",
  tag: "Tag",
  untag: "Untag",
  caption: "Caption",
  category: "Category",
  trash: "Trash",
  restore: "Restore",
  flag: "Flag",
  unflag: "Unflag",
  rule_create: "New rule",
  rule_update: "Edit rule",
};

export function StepRow({ step, names }: { step: PlanStep; names: Map<number, string> }) {
  const name = step.fileId !== undefined ? names.get(step.fileId) : undefined;
  const isPath = step.action === "move" || step.action === "rename" || step.action === "trash" || step.action === "restore";
  return (
    <div className="flex items-start gap-2 py-1.5 text-xs">
      <span className="mt-0.5 w-16 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-center font-medium text-muted">{ACTION_LABEL[step.action]}</span>
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

/** Summary, file count, before/after preview and Approve / Edit / Cancel. Nothing touches disk before Approve. */
export function PlanCard({ planId, compact = false }: { planId: number; compact?: boolean }) {
  const plan = useLiveQuery(() => db.plans.get(planId), [planId]);
  const names = useFileNames(plan?.steps ?? []);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
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
            {files > 0 && ` · ${files} file${files === 1 ? "" : "s"}`} · by {plan.actor}
          </p>
        </div>
        <StatusBadge plan={plan} />
      </div>
      <div className="divide-y px-3">
        {preview.map((s, i) => (
          <StepRow key={i} step={s} names={names} />
        ))}
        {plan.steps.length > preview.length && <p className="py-1.5 text-xs text-muted">…and {plan.steps.length - preview.length} more</p>}
      </div>
      {plan.errors && plan.errors.length > 0 && <p className="border-t px-3 py-2 text-xs text-danger">{plan.errors.length} failed: {plan.errors[0]}</p>}
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
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil />
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void cancelPlan(plan.id)}>
            <X />
            Cancel
          </Button>
        </div>
      )}
      <PlanEditDialog key={`${plan.steps.length}-${editing}`} plan={plan} names={names} open={editing} onOpenChange={setEditing} />
    </div>
  );
}

function StatusBadge({ plan }: { plan: PlanRecord }) {
  const styles: Record<PlanRecord["status"], string> = {
    pending: "bg-accent-soft text-accent",
    approved: "bg-surface-2 text-muted",
    executed: "bg-success/10 text-success",
    cancelled: "bg-surface-2 text-muted line-through",
  };
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", styles[plan.status])}>{plan.status}</span>;
}

/** Untick steps you don't want, then save. */
function PlanEditDialog({ plan, names, open, onOpenChange }: { plan: PlanRecord; names: Map<number, string>; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [keep, setKeep] = useState<Set<number>>(() => new Set(plan.steps.map((_, i) => i)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
        <DialogTitle>Edit plan</DialogTitle>
        <DialogDescription>Untick the changes you don't want. Nothing happens until you approve.</DialogDescription>
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
            Close
          </Button>
          <Button
            onClick={async () => {
              await updatePlanSteps(plan.id, plan.steps.filter((_, i) => keep.has(i)));
              onOpenChange(false);
            }}
          >
            Save {keep.size} change{keep.size === 1 ? "" : "s"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A dialog that shows one plan card, used for rule runs and "Organize". */
export function PlanDialog({ planId, onClose }: { planId: number | null; onClose: () => void }) {
  const plan = useLiveQuery(() => (planId ? db.plans.get(planId) : undefined), [planId]);
  return (
    <Dialog open={planId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Review plan</DialogTitle>
        <DialogDescription>Check the before → after preview. Nothing touches your files until you approve.</DialogDescription>
        {planId !== null && <PlanCard planId={planId} />}
        {plan && plan.status !== "pending" && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
