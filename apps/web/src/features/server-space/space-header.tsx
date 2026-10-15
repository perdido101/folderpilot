import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, HardDrive, Lock, RefreshCw, Settings2 } from "lucide-react";
import { Button, cn } from "@folderpilot/ui";
import { can } from "@folderpilot/core";
import { formatDate } from "@/lib/format";
import { toast } from "@/stores/toasts";
import { useScan, useSpaceStatus } from "./api";
import { startGoogleDrive } from "@/features/connect/api";
import { SpaceSettingsDialog } from "@/features/connect/space-settings-dialog";

export interface ActiveServerSpace {
  id: string;
  name: string;
  mode: "connect" | "cloud" | "private";
  adapterId?: string;
  needsReconnect?: string | null;
  settings?: { account?: string; rootName?: string };
  orgId: string;
  role: "owner" | "admin" | "editor" | "viewer";
}

/** Space name, mode, progress of the analysis pipeline, and "Scan & analyze". */
export function SpaceHeader({ space }: { space: ActiveServerSpace }) {
  const { t } = useTranslation(["spaces", "shell", "connect"]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const manage = space.mode === "connect" && can(space.role, "space", "update");
  const status = useSpaceStatus(space.orgId, space.id).data;
  const scan = useScan(space.orgId, space.id);
  const busy = Boolean(status && (status.scanning || status.pendingAnalysis > 0)) || scan.isPending;
  // As the worker makes progress, refresh the lists of this space (files, review, duplicates).
  const qc = useQueryClient();
  const progress = status ? `${status.total}:${status.analyzed}:${status.aiAnalyzed}:${status.needsReview}:${status.flagged}` : "";
  useEffect(() => {
    if (!progress) return;
    void qc.invalidateQueries({ queryKey: ["space", space.id], predicate: (q) => q.queryKey[2] !== "status" });
  }, [progress, qc, space.id]);
  const pct = status && status.total ? Math.round((status.analyzed / status.total) * 100) : 0;
  return (
    <div className="border-b px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <HardDrive className="size-4 text-muted" />
        <h1 className="font-semibold">{space.name}</h1>
        <span className="rounded-full border px-1.5 text-[10px] text-muted">{t(`shell:modes.${space.mode}`)}</span>
        {space.adapterId === "gdrive" && (
          <span className="rounded-full border px-1.5 text-[10px] text-muted" title={space.settings?.account}>
            {t("connect:gdrive.badge")}
            {space.settings?.rootName ? ` · ${space.settings.rootName}` : ""}
          </span>
        )}
        {status?.adapter.readOnly && (
          <span className="flex items-center gap-1 rounded-full border px-1.5 text-[10px] text-muted">
            <Lock className="size-3" />
            {t("badges.readOnly")}
          </span>
        )}
        {manage && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSettingsOpen(true)} aria-label={t("connect:space.settings")} title={t("connect:space.settings")}>
            <Settings2 />
          </Button>
        )}
        {can(space.role, "file", "organize") && (
          <Button
            size="sm"
            className={manage ? undefined : "ml-auto"}
            disabled={busy || Boolean(status?.adapter.error) || Boolean(space.needsReconnect)}
            onClick={async () => {
              try {
                await scan.mutateAsync(true);
                toast(t("header.scanQueued"));
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), "error");
              }
            }}
          >
            <RefreshCw className={cn(busy && "animate-spin motion-reduce:animate-none")} />
            {busy ? t("header.scanning") : t("header.scan")}
          </Button>
        )}
      </div>
      {space.needsReconnect && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-surface-2 px-3 py-2 text-sm" role="alert">
          <CircleAlert className="size-4 text-warning" />
          <span className="flex-1">{t("connect:space.needsReconnect", { reason: space.needsReconnect })}</span>
          {manage && (
            <Button size="sm" variant="outline" onClick={() => startGoogleDrive(space.orgId, space.id)}>
              {t("connect:space.reconnect")}
            </Button>
          )}
        </div>
      )}
      {manage && <SpaceSettingsDialog space={space} open={settingsOpen} onOpenChange={setSettingsOpen} />}
      {status && (
        <div className="mt-2 space-y-1.5" role="status">
          <p className="text-xs text-muted">
            {t("header.files", { count: status.total })} · {t("header.analyzed", { done: status.analyzed, total: status.total })} · {t("header.aiAnalyzed", { done: status.aiAnalyzed })}
            {status.needsReview > 0 && ` · ${t("header.needsReview", { count: status.needsReview })}`} ·{" "}
            {status.lastScanAt ? t("header.lastScan", { when: formatDate(status.lastScanAt) }) : t("header.neverScanned")}
          </p>
          {busy && status.total > 0 && (
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-accent transition-[width] duration-150 ease-out" style={{ width: `${pct}%` }} />
            </div>
          )}
          {status.adapter.error && <p className="text-xs text-danger">{t("header.unavailable", { reason: status.adapter.error })}</p>}
          {status.adapter.readOnly && !status.adapter.error && <p className="text-xs text-muted">{t("header.readOnlyNote")}</p>}
        </div>
      )}
    </div>
  );
}
