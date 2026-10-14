import { useTranslation } from "react-i18next";
import { useLiveQuery } from "dexie-react-hooks";
import { Bot, Info } from "lucide-react";
import { cn } from "@folderpilot/ui";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { FileDetails } from "@/features/files/file-details";
import { useSelection } from "@/stores/selection";
import { useUI } from "@/stores/ui";
import { AgentChat } from "./agent-panel";

function FileHistory({ fileId, rootId }: { fileId: number; rootId: number }) {
  const { t } = useTranslation("shell");
  const entries = useLiveQuery(
    () =>
      db.audit
        .where("rootId")
        .equals(rootId)
        .filter((e) => e.fileIds.includes(fileId))
        .reverse()
        .limit(20)
        .toArray(),
    [fileId, rootId],
  );
  if (!entries?.length) return <p className="px-1.5 text-xs text-muted">{t("details.noHistory")}</p>;
  return (
    <ol className="space-y-1.5 px-1.5">
      {entries.map((e) => (
        <li key={e.id} className={cn("text-xs", e.undone && "text-muted line-through")}>
          <span className="font-mono text-muted">{formatDate(e.at)}</span> · <span className="font-medium">{e.action}</span> · <span className="font-mono">{e.actor}</span>
          <p className="truncate font-mono text-[11px] text-muted" title={`${e.before ?? ""} → ${e.after ?? ""}`}>
            {e.before ?? "—"} → {e.after ?? "—"}
          </p>
        </li>
      ))}
    </ol>
  );
}

function DetailsTab() {
  const { t } = useTranslation("shell");
  const focusId = useSelection((s) => s.focusId);
  const file = useLiveQuery(() => (focusId === null ? undefined : db.files.get(focusId)), [focusId]);
  if (!file) return <p className="m-auto max-w-56 p-6 text-center text-sm text-muted">{t("details.empty")}</p>;
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
      <FileDetails file={file} />
      <section className="space-y-1">
        <h3 className="px-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{t("details.history")}</h3>
        <FileHistory fileId={file.id} rootId={file.rootId} />
      </section>
    </div>
  );
}

/** Right side: the agent conversation and the details of the focused file (history, why categorized). */
export function RightPanel() {
  const { t } = useTranslation("shell");
  const tab = useUI((s) => s.rightTab);
  const setTab = useUI((s) => s.setRightTab);
  const tabs = [
    { key: "agent" as const, icon: Bot, label: t("panel.agent") },
    { key: "details" as const, icon: Info, label: t("panel.details") },
  ];
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l bg-surface" aria-label={t("panel.label")}>
      <div className="flex h-14 shrink-0 items-center gap-1 border-b px-2" role="tablist">
        {tabs.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn("flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors", tab === key ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-text")}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
        {tab === "agent" && <span className="ml-auto pr-2 text-xs text-muted">{t("panel.agentHint")}</span>}
      </div>
      {tab === "agent" ? <AgentChat /> : <DetailsTab />}
    </aside>
  );
}
