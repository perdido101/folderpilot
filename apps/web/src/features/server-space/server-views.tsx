/** Views of a server space: files, Needs Review, Duplicates & Bad Files (with review mode) and the Audit Log. */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Check, Copy, ScrollText, Search, Sparkles, Trash2, Undo2 } from "lucide-react";
import { Button, Input, cn } from "@folderpilot/ui";
import { can, kindOf, type FileFlag } from "@folderpilot/core";
import { FileIcon } from "@/features/files/file-icon";
import { formatBytes, formatDate } from "@/lib/format";
import { toast } from "@/stores/toasts";
import { useSpaceAudit, useSpaceDuplicates, useSpaceFiles, useSpaceStatus, useUndoBatch, type SpaceFile } from "./api";
import { SpaceHeader, type ActiveServerSpace } from "./space-header";
import { useReviewAction } from "./use-review-action";

const BAD_FLAGS: FileFlag[] = ["blurry", "dark", "tiny", "screenshot"];

function FlagChips({ flags }: { flags: FileFlag[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f} className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
          {f.replace("_", " ")}
        </span>
      ))}
    </span>
  );
}

function FileName({ file }: { file: SpaceFile }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <FileIcon kind={kindOf(file.ext)} className="size-4" />
      <span className="min-w-0">
        <span className="block truncate">{file.name}</span>
        <span className="block truncate font-mono text-[11px] text-muted">{file.path}</span>
      </span>
    </span>
  );
}

export function ServerFilesView({ space }: { space: ActiveServerSpace }) {
  const { t } = useTranslation("spaces");
  const [q, setQ] = useState("");
  const files = useSpaceFiles(space.orgId, space.id, q ? { q } : {}).data;
  return (
    <div className="flex h-full flex-col">
      <SpaceHeader space={space} />
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Search className="size-4 text-muted" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("files.search")} aria-label={t("files.search")} className="h-8 max-w-sm" />
        {files && files.total > files.files.length && <span className="ml-auto text-xs text-muted">{t("files.more", { shown: files.files.length, total: files.total })}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files && files.files.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted">{q ? t("files.noMatch") : t("files.empty")}</p>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
              <tr className="border-b">
                <th className="px-4 py-2 font-medium">{t("files.columns.name")}</th>
                <th className="w-44 px-2 py-2 font-medium">{t("files.columns.category")}</th>
                <th className="w-48 px-2 py-2 font-medium">{t("files.columns.flags")}</th>
                <th className="w-20 px-4 py-2 text-right font-medium">{t("files.columns.size")}</th>
              </tr>
            </thead>
            <tbody>
              {files?.files.map((f) => (
                <tr key={f.id} className="border-b" title={f.caption ?? undefined}>
                  <td className="px-4 py-1.5">
                    <FileName file={f} />
                  </td>
                  <td className="truncate px-2 py-1.5">
                    {f.category ?? (f.analyzed ? "—" : <span className="inline-block h-3 w-20 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />)}
                  </td>
                  <td className="px-2 py-1.5">
                    <FlagChips flags={f.flags} />
                  </td>
                  <td className="px-4 py-1.5 text-right text-xs text-muted">{formatBytes(f.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function ServerNeedsReview({ space }: { space: ActiveServerSpace }) {
  const { t } = useTranslation("spaces");
  const files = useSpaceFiles(space.orgId, space.id, { status: "needs_review" }).data?.files;
  const action = useReviewAction(space.orgId, space.id);
  const [category, setCategory] = useState<Record<string, string>>({});
  const canAct = can(space.role, "file", "organize");
  return (
    <div className="flex h-full flex-col">
      <SpaceHeader space={space} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-4xl space-y-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">{t("review.title")}</h2>
              <p className="text-sm text-muted">{t("review.description")}</p>
            </div>
            {canAct && files && files.length > 1 && (
              <Button size="sm" variant="outline" disabled={action.pending} onClick={() => void action.run({ action: "accept", fileIds: files.map((f) => f.id) }, t("review.accepted", { count: files.length }))}>
                <Check />
                {t("review.acceptAll", { count: files.length })}
              </Button>
            )}
          </div>
          {files?.length === 0 && <p className="py-8 text-center text-sm text-muted">{t("review.empty")}</p>}
          {files?.map((f) => (
            <div key={f.id} className="rounded-lg border bg-surface p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <FileName file={f} />
                  <p className="mt-1.5 text-sm">
                    <Sparkles className="mr-1 inline size-3.5 text-accent" />
                    <span className="font-medium">{f.category}</span>
                    {f.confidence !== null && <span className="text-muted"> · {t("review.confidence", { value: Math.round(f.confidence * 100) })}</span>}
                  </p>
                  {f.aiReason && <p className="text-xs text-muted">{f.aiReason}</p>}
                  {f.caption && <p className="text-xs text-muted">{f.caption}</p>}
                </div>
                {canAct && (
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <Button size="sm" disabled={action.pending} onClick={() => void action.run({ action: "accept", fileIds: [f.id] }, t("review.accepted", { count: 1 }))}>
                      <Check />
                      {t("review.accept")}
                    </Button>
                    <form
                      className="flex gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const value = (category[f.id] ?? "").trim();
                        if (value) void action.run({ action: "set_category", fileIds: [f.id], category: value }, t("review.categorized", { count: 1 }));
                      }}
                    >
                      <Input
                        className="h-8 w-36"
                        placeholder={t("review.categoryPlaceholder")}
                        aria-label={`${t("review.setCategory")}: ${f.name}`}
                        value={category[f.id] ?? ""}
                        onChange={(e) => setCategory({ ...category, [f.id]: e.target.value })}
                      />
                      <Button size="sm" variant="outline" type="submit" disabled={action.pending}>
                        {t("review.setCategory")}
                      </Button>
                    </form>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** ← trash / → keep, one file at a time. */
function ReviewMode({ space, queue, onClose, readOnly }: { space: ActiveServerSpace; queue: SpaceFile[]; onClose: () => void; readOnly: boolean }) {
  const { t } = useTranslation("spaces");
  const canTrash = can(space.role, "file", "trash") && !readOnly;
  const action = useReviewAction(space.orgId, space.id);
  const [index, setIndex] = useState(0);
  const file = queue[index];
  const next = () => setIndex((i) => i + 1);
  const decide = async (choice: "trash" | "keep") => {
    if (!file) return;
    if (choice === "trash") {
      if (!canTrash) {
        toast(readOnly ? t("header.readOnlyNote") : t("duplicates.reviewMode.trash"), "error");
        return;
      }
      const res = await action.run({ action: "trash", fileIds: [file.id] }, t("duplicates.reviewMode.trash"));
      if (!res || res.done === 0) return; // stay on this file; the toast explains (e.g. read-only space)
    } else if (file.flags.includes("suggested_delete")) {
      await action.run({ action: "keep", fileIds: [file.id] }, t("duplicates.kept"));
    }
    next();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") void decide("trash");
      else if (e.key === "ArrowRight") void decide("keep");
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="rounded-lg border border-accent/40 bg-surface p-4" role="region" aria-label={t("duplicates.review")}>
      {file ? (
        <>
          <p className="text-xs text-muted">
            {t("duplicates.reviewMode.title", { index: index + 1, total: queue.length })} · {t("duplicates.reviewMode.hint")}
          </p>
          <div className="my-3">
            <FileName file={file} />
            <FlagChips flags={file.flags} />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="text-danger" disabled={action.pending || !canTrash} title={readOnly ? t("header.readOnlyNote") : undefined} onClick={() => void decide("trash")}>
              <ArrowLeft />
              {t("duplicates.reviewMode.trash")}
            </Button>
            <Button disabled={action.pending} onClick={() => void decide("keep")}>
              {t("duplicates.reviewMode.keep")}
              <ArrowRight />
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <p className="text-sm">{t("duplicates.reviewMode.done")}</p>
          <Button size="sm" variant="outline" onClick={onClose}>
            OK
          </Button>
        </div>
      )}
    </div>
  );
}

export function ServerDuplicates({ space }: { space: ActiveServerSpace }) {
  const { t } = useTranslation("spaces");
  const groups = useSpaceDuplicates(space.orgId, space.id).data?.groups;
  const all = useSpaceFiles(space.orgId, space.id).data?.files;
  const bad = useMemo(() => (all ?? []).filter((f) => f.flags.some((fl) => BAD_FLAGS.includes(fl))), [all]);
  const action = useReviewAction(space.orgId, space.id);
  const [reviewing, setReviewing] = useState(false);
  const readOnly = Boolean(useSpaceStatus(space.orgId, space.id).data?.adapter.readOnly);
  const queue = useMemo(() => [...(groups ?? []).flatMap((g) => g.others), ...bad.filter((b) => !(groups ?? []).some((g) => g.others.some((o) => o.id === b.id)))], [groups, bad]);
  return (
    <div className="flex h-full flex-col">
      <SpaceHeader space={space} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-4xl space-y-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">{t("duplicates.title")}</h2>
              <p className="text-sm text-muted">{t("duplicates.description")}</p>
            </div>
            {queue.length > 0 && !reviewing && (
              <Button size="sm" variant="outline" onClick={() => setReviewing(true)}>
                {t("duplicates.review")}
              </Button>
            )}
          </div>
          {reviewing && <ReviewMode space={space} queue={queue} readOnly={readOnly} onClose={() => setReviewing(false)} />}
          {groups && groups.length === 0 && bad.length === 0 && <p className="py-8 text-center text-sm text-muted">{t("duplicates.none")}</p>}
          {groups?.map((g) => (
            <section key={g.keep.id} className="rounded-lg border bg-surface">
              <header className="flex items-center gap-2 border-b px-3 py-2 text-sm">
                <Copy className="size-4 text-muted" />
                <span className="font-medium">{g.kind === "exact" ? t("duplicates.exact") : t("duplicates.near")}</span>
                {can(space.role, "file", "trash") && !readOnly && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-danger"
                    disabled={action.pending}
                    onClick={() => void action.run({ action: "trash", fileIds: g.others.map((o) => o.id) }, t("duplicates.trashCopies"))}
                  >
                    <Trash2 />
                    {t("duplicates.trashCopies")}
                  </Button>
                )}
              </header>
              <ul className="divide-y">
                {[g.keep, ...g.others].map((f, i) => (
                  <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className={cn("w-12 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium", i === 0 ? "bg-success/10 text-success" : "bg-surface-2 text-muted")}>
                      {i === 0 ? t("duplicates.keep") : t("duplicates.copy")}
                    </span>
                    <FileName file={f} />
                    <span className="ml-auto text-xs text-muted">{f.width && f.height ? `${f.width}×${f.height} · ` : ""}{formatBytes(f.size)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {bad.length > 0 && (
            <section className="rounded-lg border bg-surface">
              <header className="border-b px-3 py-2 text-sm font-medium">{t("duplicates.bad")}</header>
              <ul className="divide-y">
                {bad.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <FileName file={f} />
                    <span className="ml-auto">
                      <FlagChips flags={f.flags.filter((fl) => BAD_FLAGS.includes(fl))} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

export function ServerAudit({ space }: { space: ActiveServerSpace }) {
  const { t } = useTranslation("spaces");
  const events = useSpaceAudit(space.orgId, space.id).data?.events;
  const undo = useUndoBatch(space.orgId, space.id);
  const batches = useMemo(() => {
    const m = new Map<string, NonNullable<typeof events>>();
    for (const e of events ?? []) m.set(e.batchId ?? e.id, [...(m.get(e.batchId ?? e.id) ?? []), e]);
    return [...m];
  }, [events]);
  if (events && events.length === 0)
    return (
      <div className="flex h-full flex-col">
        <SpaceHeader space={space} />
        <p className="p-8 text-center text-sm text-muted">{t("audit.empty")}</p>
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      <SpaceHeader space={space} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-5xl space-y-3">
          <div className="flex items-start gap-2">
            <ScrollText className="mt-0.5 size-4 text-muted" />
            <div>
              <h2 className="font-semibold">{t("audit.title")}</h2>
              <p className="text-sm text-muted">{t("audit.description")}</p>
            </div>
          </div>
          {batches.map(([batchId, list]) => {
            const first = list[list.length - 1]!;
            const undoable = can(space.role, "file", "organize") && list.some((e) => e.action !== "undo" && !e.undoneBy);
            return (
              <section key={batchId} className="rounded-lg border bg-surface">
                <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
                  <span className="font-medium">{first.reason ?? first.action}</span>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{first.actor}</span>
                  <span className="text-xs text-muted">{formatDate(first.at)}</span>
                  {undoable && first.batchId && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                      disabled={undo.isPending}
                      onClick={async () => {
                        try {
                          const r = await undo.mutateAsync(first.batchId!);
                          toast(t("results.undone", { count: r.done }), "success");
                        } catch (err) {
                          toast(err instanceof Error ? err.message : String(err), "error");
                        }
                      }}
                    >
                      <Undo2 />
                      {t("audit.undo")}
                    </Button>
                  )}
                </header>
                <table className="w-full table-fixed font-mono text-xs">
                  <tbody>
                    {list.map((e) => (
                      <tr key={e.id} className={cn("border-b last:border-0", e.undoneBy && "text-muted line-through")}>
                        <td className="w-24 px-3 py-1.5 text-muted">{new Date(e.at).toLocaleTimeString()}</td>
                        <td className="w-24 px-2 py-1.5">{e.action}</td>
                        <td className="truncate px-2 py-1.5 text-muted" title={`${e.before ?? ""} → ${e.after ?? ""}`}>
                          {e.before ?? "—"} → <span className="text-text">{e.after ?? "—"}</span>
                        </td>
                        <td className="w-48 truncate px-2 py-1.5 text-muted">{e.undoneBy ? t("audit.undoneBy", { actor: e.undoneBy }) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
