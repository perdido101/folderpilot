import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Clock } from "lucide-react";
import { FileBrowser } from "@/features/files/file-browser";
import { useActiveRoot, useRootFiles } from "@/hooks/use-active-root";
import { PlaceholderPage } from "@/pages/placeholder-page";

const LIMIT = 200;

/** The most recently modified files of the active space, newest first. */
export function RecentPage() {
  const { t } = useTranslation("pages");
  const root = useActiveRoot();
  const files = useRootFiles(root?.id);
  const recent = useMemo(() => (files ?? []).filter((f) => f.status !== "trashed").sort((a, b) => b.mtime - a.mtime).slice(0, LIMIT), [files]);
  if (!root) return <PlaceholderPage icon={Clock} title={t("recent.title")} description={t("recent.noSpace")} />;
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h1 className="font-semibold">{t("recent.title")}</h1>
        <p className="text-xs text-muted">{t("recent.subtitle", { count: recent.length, space: root.name })}</p>
      </div>
      <FileBrowser rootId={root.id} files={recent} allFiles={files} ranked accessKey={0} emptyText={t("recent.empty")} />
    </div>
  );
}
