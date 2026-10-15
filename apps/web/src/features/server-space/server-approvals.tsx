/** Pending Approvals for a server space: plans from rules (later also the agent and MCP clients) wait for a person. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check, CheckCheck, ListChecks, Pencil, X } from "lucide-react";
import { can } from "@folderpilot/core";
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogTitle } from "@folderpilot/ui";
import { ApiError } from "@/lib/api";
import { PlaceholderPage } from "@/pages/placeholder-page";
import { toast } from "@/stores/toasts";
import { useServerPlan, useServerPlanActions, useServerPlans, type ServerPlan } from "@/features/rules/server-api";
import { useActorLabel } from "@/features/plans/plan-card";
import { useUndoBatch } from "./api";
import type { ActiveServerSpace } from "./space-header";

const message = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const PATH_ACTIONS = new Set(["move", "rename", "trash", "restore"]);

function StepLine({ step }: { step: ServerPlan["steps"][number] }) {
  const { t } = useTranslation("plans");
  const isPath = PATH_ACTIONS.has(step.action);
  return (
    <div className="flex items-start gap-2 py-1.5 text-xs">
      <span className="mt-0.5 w-16 shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-center font-medium text-muted">{t(`stepLabels.${step.action}`, { defaultValue: step.action })}</span>
      <div className="min-w-0 flex-1">
        {step.name && !isPath && <p className="truncate font-medium">{step.name}</p>}
        <p className={cn("truncate text-muted", isPath && "font-mono text-[11px]")} title={step.before}>
          {step.before || "—"}
        </p>
        <p className={cn("flex min-w-0 items-center gap-1", isPath && "font-mono text-[11px]")} title={step.after}>
          <ArrowRight className="size-3 shrink-0 text-accent" />
          <span className="truncate">{step.after || "—"}</span>
        </p>
      </div>
    </div>
  );
}

/** A plan on a server space: summary, files, before → after and, while pending, Approve / Edit / Cancel. */
export function ServerPlanCard({ plan, space, compact = false }: { plan: ServerPlan; space: ActiveServerSpace; compact?: boolean }) {
  const { t } = useTranslation(["plans", "common", "spaces"]);
  const actions = useServerPlanActions(space.orgId, space.id);
  const undo = useUndoBatch(space.orgId, space.id);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const actorLabel = useActorLabel();
  const canApprove = can(space.role, "plan", "approve");
  const preview = plan.steps.slice(0, compact ? 3 : 5);
  const pending = plan.status === "pending";

  const approve = async () => {
    setBusy(true);
    try {
      const res = await actions.approve(plan.id);
      const failed = res.failed + res.conflicted;
      toast(
        failed ? t("spaces:results.failed", { count: failed, error: res.errors[0] }) : `${plan.summary} · ${t("common:actions.approve")}`,
        failed ? "error" : "success",
        res.done
          ? {
              label: t("spaces:results.undo"),
              run: async () => {
                const u = await undo.mutateAsync(res.batchId);
                toast(u.failed ? t("spaces:results.failed", { count: u.failed, error: u.errors[0] }) : t("spaces:results.undone", { count: u.done }));
              },
            }
          : undefined,
      );
    } catch (err) {
      toast(message(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("rounded-lg border bg-surface", pending && "border-accent/40")} data-testid="server-plan">
      <div className="flex items-start gap-2 border-b px-3 py-2">
        <ListChecks className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{plan.summary}</p>
          <p className="text-xs text-muted">
            {t("common:file", { count: plan.fileCount })} · {t("by", { actor: actorLabel(plan.actor) })}
          </p>
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", pending ? "bg-accent-soft text-accent" : plan.status === "executed" ? "bg-success/10 text-success" : "bg-surface-2 text-muted")}>
          {t(`status.${plan.status}`, { defaultValue: plan.status })}
        </span>
      </div>
      <div className="divide-y px-3">
        {preview.map((s) => (
          <StepLine key={s.seq} step={s} />
        ))}
        {plan.steps.length > preview.length && <p className="py-1.5 text-xs text-muted">{t("more", { count: plan.steps.length - preview.length })}</p>}
      </div>
      {pending && !canApprove && <p className="border-t px-3 py-2 text-xs text-muted">{t("plans:waitingForApprover")}</p>}
      {pending && canApprove && (
        <div className="flex gap-2 border-t p-2">
          <Button size="sm" disabled={busy || plan.steps.length === 0} onClick={() => void approve()}>
            <Check />
            {t("common:actions.approve")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy}>
            <Pencil />
            {t("common:actions.edit")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void actions.cancel(plan.id).catch((err: unknown) => toast(message(err), "error"))}>
            <X />
            {t("common:actions.cancel")}
          </Button>
        </div>
      )}
      {editing && <EditSteps plan={plan} onClose={() => setEditing(false)} onSave={(seqs) => actions.keepSteps(plan.id, seqs)} />}
    </div>
  );
}

/** A plan loaded by id (Plan Cards in the agent chat). */
export function ServerPlanById({ planId, space, compact }: { planId: string; space: ActiveServerSpace; compact?: boolean }) {
  const plan = useServerPlan(space.orgId, space.id, planId).data?.plan;
  return plan ? <ServerPlanCard plan={plan} space={space} {...(compact !== undefined ? { compact } : {})} /> : null;
}

/** Untick steps you don't want, then save (the plan stays pending). */
function EditSteps({ plan, onClose, onSave }: { plan: ServerPlan; onClose: () => void; onSave: (seqs: number[]) => Promise<unknown> }) {
  const { t } = useTranslation(["plans", "common"]);
  const [keep, setKeep] = useState(() => new Set(plan.steps.map((s) => s.seq)));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col">
        <DialogTitle>{t("edit.title")}</DialogTitle>
        <DialogDescription>{t("edit.description")}</DialogDescription>
        <div className="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border px-3">
          {plan.steps.map((s) => (
            <label key={s.seq} className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                className="size-4 accent-[rgb(var(--accent))]"
                checked={keep.has(s.seq)}
                onChange={(e) => {
                  const next = new Set(keep);
                  if (e.target.checked) next.add(s.seq);
                  else next.delete(s.seq);
                  setKeep(next);
                }}
              />
              <div className="min-w-0 flex-1">
                <StepLine step={s} />
              </div>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("common:actions.close")}
          </Button>
          <Button
            onClick={async () => {
              try {
                await onSave([...keep]);
                onClose();
              } catch (err) {
                toast(message(err), "error");
              }
            }}
          >
            {t("edit.save", { count: keep.size })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ServerApprovals({ space }: { space: ActiveServerSpace }) {
  const { t } = useTranslation("pages");
  const plans = useServerPlans(space.orgId, space.id).data?.plans;
  if (plans && !plans.length) return <PlaceholderPage icon={CheckCheck} title={t("approvals.emptyTitle")} description={t("approvals.empty")} />;
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-3">
        <div>
          <h1 className="font-semibold">{t("approvals.title")}</h1>
          <p className="text-xs text-muted">{t("approvals.subtitle", { count: plans?.length ?? 0 })}</p>
        </div>
        {plans?.map((p) => <ServerPlanCard key={p.id} plan={p} space={space} />)}
      </div>
    </div>
  );
}
