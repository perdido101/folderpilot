/** "Agent activity": every tool call the agent made (spec §9), next to the audit log of changes. */
import type { ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, Bot, Check, ScrollText } from "lucide-react";
import { cn } from "@folderpilot/ui";
import { api } from "@/lib/api";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { useActiveRoot } from "@/hooks/use-active-root";
import { useActiveServerSpace } from "@/features/server-space/api";

interface ActivityRow {
  id: string | number;
  at: number;
  tool: string;
  input: string;
  ok: boolean;
  error?: string | null;
  durationMs: number;
  who?: string;
}

function useActivity(): ActivityRow[] | undefined {
  const root = useActiveRoot();
  const space = useActiveServerSpace();
  const device = useLiveQuery(() => (root && !space ? db.agentLog.where("rootId").equals(root.id).reverse().limit(500).toArray() : []), [root?.id, space?.id]);
  const server = useQuery({
    queryKey: ["agent-activity", space?.orgId, space?.id],
    enabled: Boolean(space),
    queryFn: () => api<{ calls: (ActivityRow & { userId: string })[] }>(`/api/orgs/${space!.orgId}/agent/activity?spaceId=${space!.id}`),
  }).data;
  if (space) return server?.calls.map((c) => ({ ...c, who: c.userId }));
  return device;
}

export function AgentActivity() {
  const { t } = useTranslation("audit");
  const rows = useActivity();
  if (rows && !rows.length) return <p className="p-8 text-center text-sm text-muted">{t("activity.empty")}</p>;
  return (
    <div className="mx-auto max-w-5xl p-4">
      <p className="mb-3 text-sm text-muted">{t("activity.description")}</p>
      <div className="overflow-hidden rounded-lg border bg-surface">
        <table className="w-full text-xs">
          <thead className="bg-surface-2 text-left text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">{t("activity.when")}</th>
              <th className="px-3 py-2 font-medium">{t("activity.tool")}</th>
              <th className="px-3 py-2 font-medium">{t("activity.input")}</th>
              <th className="px-3 py-2 font-medium">{t("activity.result")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows?.map((r) => (
              <tr key={r.id} data-testid="activity-row">
                <td className="whitespace-nowrap px-3 py-1.5 text-muted">{formatDate(r.at)}</td>
                <td className="px-3 py-1.5 font-medium">{r.tool}</td>
                <td className="max-w-md truncate px-3 py-1.5 font-mono text-[11px] text-muted" title={r.input}>
                  {r.input}
                </td>
                <td className="px-3 py-1.5">
                  {r.ok ? (
                    <span className="inline-flex items-center gap-1 text-success">
                      <Check className="size-3" /> {t("activity.ok", { ms: r.durationMs })}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-warning" title={r.error ?? ""}>
                      <AlertCircle className="size-3" /> {r.error ?? t("activity.failed")}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Tabs above the Audit Log: Changes (the append-only log) and Agent activity (tool calls). */
export function AuditTabs({ children }: { children: ReactNode }) {
  const { t } = useTranslation("audit");
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "agent" ? "agent" : "changes";
  const tabCls = (on: boolean) => cn("inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm", on ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text");
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 border-b px-4" role="tablist">
        <button role="tab" aria-selected={tab === "changes"} className={tabCls(tab === "changes")} onClick={() => setParams({})}>
          <ScrollText className="size-3.5" /> {t("tabs.changes")}
        </button>
        <button role="tab" aria-selected={tab === "agent"} className={tabCls(tab === "agent")} onClick={() => setParams({ tab: "agent" })}>
          <Bot className="size-3.5" /> {t("tabs.agent")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "agent" ? <AgentActivity /> : children}</div>
    </div>
  );
}
