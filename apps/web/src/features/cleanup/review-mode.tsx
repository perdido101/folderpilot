import { useCallback, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Trash2, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@folderpilot/ui";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@folderpilot/ui";
import type { FileRecord } from "@/lib/db";
import { trashFiles, unflag } from "@/lib/actions/user-actions";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@folderpilot/ui";
import { FileIcon } from "@/features/files/file-icon";
import { useFileUrl } from "@/hooks/use-file-url";

export interface ReviewItem {
  file: FileRecord;
  /** For duplicates: the copy we suggest keeping, shown side by side. */
  keep?: FileRecord;
  reason: string;
}

function Preview({ file, label, tone }: { file: FileRecord; label: string; tone: "keep" | "candidate" }) {
  const { t } = useTranslation("cleanup");
  const url = useFileUrl(file.kind === "image" ? file : undefined);
  return (
    <figure className={cn("flex min-w-0 flex-1 flex-col gap-2 rounded-lg border p-2", tone === "keep" ? "border-success/40" : "border-border")}>
      <figcaption className={cn("text-xs font-medium", tone === "keep" ? "text-success" : "text-muted")}>{label}</figcaption>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-surface-2">
        {url ? <img src={url} alt={file.name} className="max-h-full max-w-full object-contain" /> : <FileIcon kind={file.kind} className="size-16" />}
      </div>
      <div className="min-w-0 text-xs">
        <p className="truncate font-medium" title={file.name}>
          {file.name}
        </p>
        <p className="truncate font-mono text-muted" title={file.path}>
          {file.path}
        </p>
        <p className="text-muted">
          {formatBytes(file.size)} · {formatDate(file.mtime)}
          {file.width ? ` · ${file.width}×${file.height}` : ""}
          {file.blurScore !== undefined ? ` · ${t("review.sharpness", { value: Math.round(file.blurScore) })}` : ""}
        </p>
      </div>
    </figure>
  );
}

/**
 * One-by-one review: → keep, ← trash (Backspace to go back). Decisions are only applied at the end,
 * as one undoable batch. Trash = move to .folderpilot-trash, never permanent deletion.
 */
export function ReviewMode({ rootId, items, title, onClose }: { rootId: number; items: ReviewItem[]; title: string; onClose: () => void }) {
  const { t } = useTranslation(["cleanup", "common"]);
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Map<number, "keep" | "trash">>(new Map());
  const done = index >= items.length;
  const item = items[index];

  const decide = useCallback(
    (d: "keep" | "trash") => {
      if (!item) return;
      setDecisions((m) => new Map(m).set(item.file.id, d));
      setIndex((i) => i + 1);
    },
    [item],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // keep the file grid's shortcuts out of review mode
    if (done) return;
    if (e.key === "ArrowRight") decide("keep");
    else if (e.key === "ArrowLeft") decide("trash");
    else if (e.key === "Backspace" || e.key.toLowerCase() === "z") setIndex((i) => Math.max(0, i - 1));
    else return;
    e.preventDefault();
  };

  const toTrash = items.filter((i) => decisions.get(i.file.id) === "trash").map((i) => i.file);
  const kept = items.filter((i) => decisions.get(i.file.id) === "keep").map((i) => i.file);

  const finish = async () => {
    if (toTrash.length) await trashFiles(rootId, toTrash, t("review.auditReason", { title }));
    const keptFlagged = kept.filter((f) => f.flags.includes("suggested_delete"));
    if (keptFlagged.length) await unflag(rootId, keptFlagged, "suggested_delete");
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[88vh] max-w-6xl flex-col gap-3" onKeyDown={onKeyDown}>
        <div className="pr-8">
          <DialogTitle>{t("review.title", { title })}</DialogTitle>
          <DialogDescription>
            {done ? t("review.allReviewed") : t("review.progress", { index: index + 1, total: items.length, reason: item?.reason })} · {t("review.hint")}
          </DialogDescription>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${(Math.min(index, items.length) / items.length) * 100}%` }} />
        </div>
        {!done && item ? (
          <>
            <div className="flex min-h-0 flex-1 gap-3">
              {item.keep && <Preview file={item.keep} label={t("review.suggestedKeep")} tone="keep" />}
              <Preview file={item.file} label={item.keep ? t("review.thisCopy") : t("review.thisFile")} tone="candidate" />
            </div>
            <div className="flex items-center justify-center gap-3">
              <Button variant="outline" size="lg" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} aria-label={t("common:actions.back")}>
                <Undo2 />
              </Button>
              <Button variant="outline" size="lg" className="min-w-36 border-danger/40 text-danger hover:bg-danger/10" onClick={() => decide("trash")}>
                <ArrowLeft />
                {t("review.trash")}
              </Button>
              <Button size="lg" className="min-w-36" onClick={() => decide("keep")}>
                {t("review.keep")}
                <ArrowRight />
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <div className="rounded-full bg-accent-soft p-4 text-accent">
              <Check className="size-6" />
            </div>
            <p className="text-lg font-semibold">
              {t("review.summary", { trash: toTrash.length, keep: kept.length })}
            </p>
            <p className="max-w-md text-sm text-muted">{t("review.explainer")}</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setIndex(0)}>
                {t("review.startOver")}
              </Button>
              <Button onClick={finish} variant={toTrash.length ? "destructive" : "default"}>
                {toTrash.length ? (
                  <>
                    <Trash2 /> {t("review.moveToTrash", { count: toTrash.length })}
                  </>
                ) : (
                  t("common:actions.done")
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
