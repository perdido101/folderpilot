import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@folderpilot/ui";
import { useIndexing } from "@/stores/indexing";

export function IndexProgressCard() {
  const { t } = useTranslation(["intake", "common"]);
  const { rootName, progress, cancel } = useIndexing();
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-4 rounded-lg border bg-surface p-6" role="status" aria-live="polite">
        <div className="flex items-center gap-3">
          <Loader2 className="size-5 animate-spin text-accent" />
          <div className="min-w-0">
            <p className="font-medium">{t("progress.title", { name: rootName })}</p>
            <p className="text-xs text-muted">{t("progress.subtitle")}</p>
          </div>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-1/3 animate-[fp-indeterminate_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
        </div>
        <div className="flex gap-6 text-sm">
          <span>
            <span className="font-semibold tabular-nums">{progress.scanned.toLocaleString()}</span> <span className="text-muted">{t("progress.files", { count: progress.scanned })}</span>
          </span>
          <span>
            <span className="font-semibold tabular-nums">{progress.dirs.toLocaleString()}</span> <span className="text-muted">{t("progress.folders", { count: progress.dirs })}</span>
          </span>
        </div>
        <p className="truncate font-mono text-xs text-muted" title={progress.currentPath}>
          {progress.currentPath || "…"}
        </p>
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={cancel}>
            {t("common:actions.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
