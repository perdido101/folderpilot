import { useTranslation } from "react-i18next";
import { useLiveQuery } from "dexie-react-hooks";
import { CheckCheck } from "lucide-react";
import { db } from "@/lib/db";
import { PlanCard } from "@/features/plans/plan-card";
import { useActiveRoot } from "@/hooks/use-active-root";
import { PlaceholderPage } from "@/pages/placeholder-page";

/** Plans proposed by the agent, rules or bulk actions that wait for a human to approve. */
export function ApprovalsPage() {
  const { t } = useTranslation("pages");
  const root = useActiveRoot();
  const plans = useLiveQuery(() => (root ? db.plans.where("rootId").equals(root.id).filter((p) => p.status === "pending").reverse().sortBy("createdAt") : []), [root?.id]);
  if (!root) return <PlaceholderPage icon={CheckCheck} title={t("approvals.title")} description={t("approvals.noSpace")} />;
  if (plans && !plans.length) return <PlaceholderPage icon={CheckCheck} title={t("approvals.emptyTitle")} description={t("approvals.empty")} />;
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-3">
        <div>
          <h1 className="font-semibold">{t("approvals.title")}</h1>
          <p className="text-xs text-muted">{t("approvals.subtitle", { count: plans?.length ?? 0 })}</p>
        </div>
        {plans?.map((p) => <PlanCard key={p.id} planId={p.id} />)}
      </div>
    </div>
  );
}
