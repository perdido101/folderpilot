import { useState } from "react";
import { Check, Inbox, Sparkles, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@folderpilot/ui";
import { Input } from "@folderpilot/ui";
import type { FileRecord } from "@/lib/db";
import { acceptReview, renameOne, setCategory, trashFiles, unflag } from "@/lib/actions/user-actions";
import { runAIAnalysis } from "@/lib/ai/pipeline";
import { Thumbnail } from "@/features/files/thumbnail";
import { useActiveRoot, useRootFiles } from "@/hooks/use-active-root";
import { useSelection } from "@/stores/selection";
import { toast } from "@/stores/toasts";
import { PlaceholderPage } from "@/pages/placeholder-page";

function ReviewRow({ file, ids, categories }: { file: FileRecord; ids: number[]; categories: string[] }) {
  const { t } = useTranslation("review");
  const open = useSelection((s) => s.openQuickLook);
  const [category, setCat] = useState(file.category ?? "");
  const [name, setName] = useState(file.suggestedName ?? "");
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-surface p-2">
      <button className="w-20 shrink-0" onClick={() => open(file.id, ids)} aria-label={t("row.preview", { name: file.name })}>
        <Thumbnail file={file} accessKey={0} />
      </button>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium" title={file.path}>
          {file.name}
        </p>
        <p className="truncate text-xs text-muted">
          {file.confidence !== undefined && <span className="text-warning">{t("row.sure", { percent: Math.round(file.confidence * 100) })} · </span>}
          {file.caption || file.aiReason || t("row.noDescription")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Input value={category} onChange={(e) => setCat(e.target.value)} list="fp-review-categories" placeholder={t("row.category")} className="h-8 w-40 text-xs" aria-label={t("row.category")} />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("row.newNamePlaceholder")} className="h-8 min-w-48 flex-1 text-xs" aria-label={t("row.newName")} />
        </div>
      </div>
      <Button
        size="sm"
        onClick={async () => {
          if (category && category !== file.category) await setCategory(file.rootId, [file], category);
          else await acceptReview([file]);
          if (name.trim() && name.trim() !== file.name) await renameOne(file.rootId, file, name);
        }}
      >
        <Check />
        {t("row.accept")}
      </Button>
      <datalist id="fp-review-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  );
}

function DeleteRow({ file, ids }: { file: FileRecord; ids: number[] }) {
  const { t } = useTranslation("review");
  const open = useSelection((s) => s.openQuickLook);
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-surface p-2">
      <button className="w-20 shrink-0" onClick={() => open(file.id, ids)} aria-label={t("row.preview", { name: file.name })}>
        <Thumbnail file={file} accessKey={0} />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{file.name}</p>
        <p className="truncate font-mono text-xs text-muted">{file.path}</p>
        <p className="text-xs text-danger">{t("row.why", { reason: file.flagReason ?? t("row.defaultReason") })}</p>
      </div>
      <Button size="sm" variant="outline" onClick={() => void unflag(file.rootId, [file], "suggested_delete")}>
        {t("row.keep")}
      </Button>
      <Button size="sm" variant="destructive" onClick={() => void trashFiles(file.rootId, [file], file.flagReason)}>
        <Trash2 />
        {t("row.trash")}
      </Button>
    </div>
  );
}

export function NeedsReviewPage() {
  const { t } = useTranslation("review");
  const root = useActiveRoot();
  const files = useRootFiles(root?.id) ?? [];
  if (!root) return <PlaceholderPage icon={Inbox} title={t("page.title")} description={t("page.noFolder")} />;
  const lowConfidence = files.filter((f) => f.status === "needs_review");
  const deletions = files.filter((f) => f.flags.includes("suggested_delete") && f.status !== "trashed");
  const categories = [...new Set(files.map((f) => f.category).filter((c): c is string => Boolean(c)))].sort();

  if (!lowConfidence.length && !deletions.length)
    return <PlaceholderPage icon={Inbox} title={t("page.emptyTitle")} description={t("page.emptyDescription")} />;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-4xl space-y-8">
        {deletions.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">{t("page.deletionTitle")}</h2>
              <span className="text-xs text-muted">{t("page.deletionHint", { count: deletions.length })}</span>
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => void unflag(root.id, deletions, "suggested_delete")}>
                {t("page.keepAll")}
              </Button>
            </div>
            {deletions.map((f) => (
              <DeleteRow key={f.id} file={f} ids={deletions.map((d) => d.id)} />
            ))}
          </section>
        )}
        {lowConfidence.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">{t("page.unsureTitle")}</h2>
              <span className="text-xs text-muted">{t("page.unsureHint", { count: lowConfidence.length })}</span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() =>
                  void runAIAnalysis(root.id, lowConfidence.map((f) => f.id))
                    .then((r) => toast(t("page.reanalyzed", { confident: r.analyzed, unsure: r.review })))
                    .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"))
                }
              >
                <Sparkles />
                {t("page.reanalyze")}
              </Button>
              <Button size="sm" onClick={() => void acceptReview(lowConfidence)}>
                <Check />
                {t("page.acceptAll")}
              </Button>
            </div>
            {lowConfidence.map((f) => (
              <ReviewRow key={f.id} file={f} ids={lowConfidence.map((d) => d.id)} categories={categories} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
