import { useTranslation } from "react-i18next";
import { Cloud, HardDrive, Laptop, Server, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, cn } from "@folderpilot/ui";
import { chooseFolder } from "@/lib/folder-source";
import { useFeatures } from "@/hooks/use-me";
import { useIndexing } from "@/stores/indexing";
import { useMode } from "@/stores/mode";

type SourceKey = "device" | "cloud" | "gdrive" | "onedrive" | "dropbox" | "server";

interface Source {
  key: SourceKey;
  icon: LucideIcon;
  mode: "private" | "cloud" | "connect";
  /** Phase in which this source becomes available (none = available now). */
  phase?: number;
  /** Needs this server feature to be configured. */
  feature?: (f: NonNullable<ReturnType<typeof useFeatures>["data"]>) => boolean;
}

const SOURCES: Source[] = [
  { key: "device", icon: Laptop, mode: "private" },
  { key: "cloud", icon: Cloud, mode: "cloud", phase: 7, feature: (f) => f.cloudStorage },
  { key: "gdrive", icon: HardDrive, mode: "connect", phase: 8, feature: (f) => f.connect.gdrive },
  { key: "onedrive", icon: HardDrive, mode: "connect", phase: 8, feature: (f) => f.connect.onedrive },
  { key: "dropbox", icon: HardDrive, mode: "connect", phase: 8, feature: (f) => f.connect.dropbox },
  { key: "server", icon: Server, mode: "private", phase: 9 },
];

/** Pick where files come from: this computer (works now), FolderPilot Cloud, a cloud drive, or a company server. */
export function ConnectSourceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["shell", "common"]);
  const connectFolder = useIndexing((s) => s.connectFolder);
  const features = useFeatures().data;
  const deviceOnly = useMode((s) => s.mode) === "device";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t("connect.title")}</DialogTitle>
        <DialogDescription>{t("connect.subtitle")}</DialogDescription>
        <ul className="space-y-2">
          {SOURCES.filter((s) => !deviceOnly || s.key === "device").map((s) => {
            const ready = s.phase === undefined;
            const configured = !s.feature || (features ? s.feature(features) : false);
            const Icon = s.icon;
            return (
              <li key={s.key}>
                <button
                  disabled={!ready}
                  onClick={async () => {
                    const source = await chooseFolder();
                    if (!source) return;
                    onOpenChange(false);
                    await connectFolder(source);
                  }}
                  className={cn("flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors", ready ? "hover:bg-surface-2" : "cursor-not-allowed opacity-70")}
                >
                  <Icon className={cn("mt-0.5 size-5 shrink-0", ready ? "text-accent" : "text-muted")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {t(`connect.sources.${s.key}.title`)}
                      <span className="rounded-full border px-1.5 text-[10px] font-normal text-muted">{t(`modes.${s.mode}`)}</span>
                    </span>
                    <span className="block text-xs text-muted">{t(`connect.sources.${s.key}.description`)}</span>
                    {!ready && (
                      <span className="mt-1 block text-xs text-warning">
                        {t("common:status.comingInPhase", { phase: s.phase })}
                        {s.feature && !configured ? ` · ${t("connect.needsSetup")}` : ""}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
