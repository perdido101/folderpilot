import { useState } from "react";
import { FolderInput, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@folderpilot/ui";
import { isFileSystemAccessSupported } from "@/lib/fs-access";
import { chooseFolder } from "@/lib/folder-source";
import { cn } from "@folderpilot/ui";
import { useIndexing } from "@/stores/indexing";
import { useFolderDrop } from "./use-folder-drop";

export function DropZone() {
  const { t } = useTranslation("intake");
  const connectFolder = useIndexing((s) => s.connectFolder);
  const [error, setError] = useState<string | null>(null);
  const { dragging, bind } = useFolderDrop((h) => void connectFolder(h), setError);
  const supported = isFileSystemAccessSupported();

  const choose = async () => {
    setError(null);
    try {
      const source = await chooseFolder();
      if (source) await connectFolder(source);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("dropZone.openError"));
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div
        {...bind}
        className={cn(
          "flex w-full max-w-2xl flex-col items-center gap-4 rounded-lg border-2 border-dashed px-8 py-20 text-center transition-colors duration-150",
          dragging ? "border-accent bg-accent-soft" : "border-border bg-surface",
        )}
      >
        <div className={cn("rounded-full p-4 transition-colors", dragging ? "bg-accent text-accent-foreground" : "bg-accent-soft text-accent")}>
          <FolderInput className="size-8" />
        </div>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{dragging ? t("dropZone.release") : t("dropZone.title")}</h1>
          <p className="text-muted">{t("dropZone.subtitle")}</p>
        </div>
        <Button size="lg" onClick={choose}>
          {t("dropZone.choose")}
        </Button>
        {!supported && <p className="max-w-md text-xs text-warning">{t("dropZone.readOnlyNotice")}</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Lock className="size-3" />
          {t("dropZone.privacy")}
        </p>
      </div>
    </div>
  );
}
